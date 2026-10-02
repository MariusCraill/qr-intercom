const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');
const { run, getOne } = require('./db');
const { verifyToken } = require('./auth');

const RING_TIMEOUT_MS = parseInt(process.env.RING_TIMEOUT_MS) || 45 * 1000;

let io = null;
const activeCalls = new Map();
const ringTimeouts = new Map();

function initWebRTC(...httpServers) {
  io = new Server({
    cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e6
  });

  // One Socket.IO instance shared by both listeners, so a call started over
  // HTTP is signalled over the same channel that answers it.
  for (const server of httpServers.flat()) {
    if (server) io.attach(server);
  }

  // Handshake auth: a socket may identify itself, but nothing is trusted until
  // the token is verified. Anonymous sockets can only start gate calls.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next();
    const decoded = verifyToken(token);
    if (!decoded) return next(new Error('invalid token'));
    socket.data.user = getOne('SELECT id, name, email, apartment, is_admin FROM residents WHERE id = ?', [decoded.id]);
    if (!socket.data.user) return next(new Error('unknown user'));
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    console.log(`[WS] Connected ${socket.id}${user ? ` as ${user.email}` : ' (anonymous)'}`);

    // Visitors may only ring a gate that actually exists.
    socket.on('call:request', (data) => {
      const gateId = String(data?.gateId || '');
      if (!getOne('SELECT id FROM gates WHERE id = ?', [gateId])) {
        socket.emit('call:error', { error: 'Gate not found' });
        return;
      }

      const callId = uuid();
      const visitorId = String(data?.visitorId || `visitor-${socket.id.slice(0, 8)}`);

      run('INSERT INTO call_logs (id, gate_id, status) VALUES (?, ?, ?)', [callId, gateId, 'ringing']);

      activeCalls.set(callId, {
        id: callId,
        gateId,
        visitorSocketId: socket.id,
        visitorId,
        status: 'ringing',
        startedAt: new Date().toISOString()
      });

      socket.join(`call:${callId}`);
      io.emit('call:incoming', { callId, gateId, visitorId, timestamp: new Date().toISOString() });
      scheduleRingTimeout(callId);
      console.log(`[CALL] Incoming call ${callId} from gate ${gateId}`);
    });

    socket.on('call:direct-request', (data) => {
      const residentId = String(data?.residentId || '');
      const resident = getOne('SELECT id, name, apartment FROM residents WHERE id = ?', [residentId]);
      if (!resident) {
        socket.emit('call:error', { error: 'Resident not found' });
        return;
      }

      const callId = uuid();
      const visitorId = String(data?.visitorId || `visitor-${socket.id.slice(0, 8)}`);

      run('INSERT INTO call_logs (id, resident_id, status) VALUES (?, ?, ?)', [callId, residentId, 'ringing']);

      activeCalls.set(callId, {
        id: callId,
        residentId,
        visitorSocketId: socket.id,
        visitorId,
        status: 'ringing',
        startedAt: new Date().toISOString()
      });

      socket.join(`call:${callId}`);
      socket.emit('call:requested', { callId, residentId, timestamp: new Date().toISOString() });
      io.to(`resident:${residentId}`).emit('call:direct-incoming', {
        callId,
        residentId,
        visitorId,
        residentName: resident.name,
        timestamp: new Date().toISOString()
      });
      scheduleRingTimeout(callId);
      console.log(`[CALL] Direct call ${callId} to resident ${resident.name} (${residentId})`);
    });

    socket.on('call:resident-join', (data) => {
      const residentId = String(data?.residentId || '');
      // A socket may only subscribe to its own resident room.
      if (!user) return socket.emit('call:error', { error: 'Authentication required' });
      if (user.id !== residentId && !user.is_admin) {
        return socket.emit('call:error', { error: 'Not allowed to join this room' });
      }
      socket.join(`resident:${residentId}`);
      console.log(`[WS] Resident ${residentId} joined room`);
    });

    socket.on('call:answer', (data) => {
      const call = activeCalls.get(data?.callId);
      if (!call) return;
      if (!user) return socket.emit('call:error', { error: 'Authentication required' });
      // A direct call is addressed to one resident; a gate call is not, so the
      // first resident to answer becomes the owner of this call.
      if (call.residentId && user.id !== call.residentId && !user.is_admin) {
        return socket.emit('call:error', { error: 'Not your call' });
      }
      if (call.residentSocketId && call.residentSocketId !== socket.id) {
        return socket.emit('call:error', { error: 'Call already answered' });
      }

      clearRingTimeout(call.id);
      call.status = 'active';
      call.residentSocketId = socket.id;
      call.answeredAt = new Date().toISOString();
      const answeringResidentId = call.residentId || user.id;
      call.answeredBy = user.id;

      run("UPDATE call_logs SET status = 'active', answered_at = ?, resident_id = ? WHERE id = ?",
        [call.answeredAt, answeringResidentId, call.id]);

      socket.join(`call:${call.id}`);
      io.to(call.visitorSocketId).emit('call:answered', { callId: call.id });
      console.log(`[CALL] Call ${call.id} answered by ${user.email}`);
    });

    socket.on('call:end', (data) => {
      const call = activeCalls.get(data?.callId);
      if (!call) return;
      if (socket.id !== call.visitorSocketId && socket.id !== call.residentSocketId) return;
      endCall(call.id);
    });

    socket.on('call:unlock', (data) => {
      const call = activeCalls.get(data?.callId);
      if (!call) return;
      if (!user) return socket.emit('call:error', { error: 'Authentication required' });
      // Only the resident who answered (or an admin) may open the door.
      if (user.id !== call.answeredBy && !user.is_admin) {
        return socket.emit('call:error', { error: 'Not authorized to unlock' });
      }
      if (call.status !== 'active') {
        return socket.emit('call:error', { error: 'Answer the call before unlocking' });
      }
      if (!call.gateId) return socket.emit('call:error', { error: 'This call has no gate attached' });
      // One unlock per call, so a replayed or duplicated event cannot reopen the door.
      if (call.unlockedAt) return socket.emit('call:error', { error: 'Gate already unlocked for this call' });

      const { unlockGate } = require('./mqtt');
      const sent = unlockGate(call.gateId, user.id);
      if (!sent) return socket.emit('call:error', { error: 'Gate controller unreachable' });
      call.unlockedAt = new Date().toISOString();

      io.to(call.visitorSocketId).emit('gate:unlocked', { callId: call.id });
      console.log(`[CALL] Gate ${call.gateId} unlocked by ${user.email} for call ${call.id}`);
    });

    socket.on('webrtc:offer', (data) => {
      const call = activeCalls.get(data?.callId);
      if (!call) return;
      io.to(call.residentSocketId || call.visitorSocketId)
        .emit('webrtc:offer', { callId: call.id, offer: data.offer });
    });

    socket.on('webrtc:answer', (data) => {
      const call = activeCalls.get(data?.callId);
      if (!call) return;
      const targetId = call.residentSocketId === socket.id ? call.visitorSocketId : call.residentSocketId;
      io.to(targetId).emit('webrtc:answer', { callId: call.id, answer: data.answer });
    });

    socket.on('webrtc:ice-candidate', (data) => {
      const call = activeCalls.get(data?.callId);
      if (!call) return;
      const targetId = call.residentSocketId === socket.id ? call.visitorSocketId : call.residentSocketId;
      io.to(targetId).emit('webrtc:ice-candidate', { callId: call.id, candidate: data.candidate });
    });

    socket.on('disconnect', () => {
      for (const [callId, call] of activeCalls) {
        if (call.visitorSocketId === socket.id || call.residentSocketId === socket.id) {
          endCall(callId);
        }
      }
    });
  });

  return io;
}

// Rings that are never answered are closed out instead of leaking rows and sockets.
function scheduleRingTimeout(callId) {
  clearRingTimeout(callId);
  const t = setTimeout(() => {
    ringTimeouts.delete(callId);
    const call = activeCalls.get(callId);
    if (!call || call.status !== 'ringing') return;
    io?.to(`call:${callId}`).emit('call:ended', { callId, reason: 'no-answer' });
    endCall(callId, 'missed');
  }, RING_TIMEOUT_MS);
  if (t.unref) t.unref();
  ringTimeouts.set(callId, t);
}

function clearRingTimeout(callId) {
  const t = ringTimeouts.get(callId);
  if (t) {
    clearTimeout(t);
    ringTimeouts.delete(callId);
  }
}

function endCall(callId, finalStatus = 'ended') {
  const call = activeCalls.get(callId);
  if (!call) return;
  clearRingTimeout(callId);

  call.status = finalStatus;
  const endedAt = new Date().toISOString();
  const duration = call.answeredAt
    ? Math.max(0, Math.floor((new Date(endedAt) - new Date(call.answeredAt)) / 1000))
    : 0;

  run(
    'UPDATE call_logs SET status = ?, ended_at = ?, duration = ? WHERE id = ?',
    [finalStatus, endedAt, duration, callId]
  );

  if (call.visitorSocketId) io.to(call.visitorSocketId).emit('call:ended', { callId });
  if (call.residentSocketId) io.to(call.residentSocketId).emit('call:ended', { callId });

  activeCalls.delete(callId);
  console.log(`[CALL] Call ${callId} ${finalStatus}, duration: ${duration}s`);
}

function getIO() {
  return io;
}

module.exports = { initWebRTC, getIO, activeCalls };
