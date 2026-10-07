const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');
const { run, getOne } = require('./db');
const { verifyToken, findUserById } = require('./auth');
const mqtt = require('./mqtt');

const RING_TIMEOUT_MS = parseInt(process.env.RING_TIMEOUT_MS) || 45 * 1000;

let io = null;
const activeCalls = new Map();
const ringTimeouts = new Map();

// Every authenticated socket sits in this room so it can be rung for gate calls.
// Anonymous sockets (visitors, kiosks) never learn about other people's calls.
const RESIDENTS_ROOM = 'residents';

// The room that is rung for a call before anyone answers it.
function ringRoom(call) {
  return call.residentId ? `resident:${call.residentId}` : RESIDENTS_ROOM;
}

// Signalling may only flow between the two ends of a call, never from a bystander.
function peerOf(call, socketId) {
  if (socketId === call.visitorSocketId) return call.residentSocketId || null;
  if (socketId === call.residentSocketId) return call.visitorSocketId;
  return null;
}

const now = () => new Date().toISOString();

// Records a new ringing call from a visitor socket. A gate call carries gateId and
// rings every resident; a direct call carries residentId and rings only them.
function openCall(socket, data, { gateId = null, residentId = null }) {
  const call = {
    id: uuid(),
    gateId,
    residentId,
    visitorSocketId: socket.id,
    visitorId: String(data?.visitorId || `visitor-${socket.id.slice(0, 8)}`),
    status: 'ringing',
    startedAt: now()
  };

  run('INSERT INTO call_logs (id, gate_id, resident_id, status) VALUES (?, ?, ?, ?)',
    [call.id, gateId, residentId, 'ringing']);
  activeCalls.set(call.id, call);
  socket.join(`call:${call.id}`);
  scheduleRingTimeout(call.id);
  return call;
}

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
    socket.data.user = findUserById(decoded.id);
    if (!socket.data.user) return next(new Error('unknown user'));
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    console.log(`[WS] Connected ${socket.id}${user ? ` as ${user.email}` : ' (anonymous)'}`);

    // Join on connect rather than on request, so a reconnect does not silently
    // stop a resident's phone from ringing.
    if (user) {
      socket.join(RESIDENTS_ROOM);
      socket.join(`resident:${user.id}`);
    }

    // Visitors may only ring a gate that actually exists.
    socket.on('call:request', (data) => {
      const gateId = String(data?.gateId || '');
      if (!getOne('SELECT id FROM gates WHERE id = ?', [gateId])) {
        socket.emit('call:error', { error: 'Gate not found' });
        return;
      }

      const call = openCall(socket, data, { gateId });
      const timestamp = call.startedAt;
      socket.emit('call:requested', { callId: call.id, gateId, timestamp });
      io.to(RESIDENTS_ROOM).emit('call:incoming', { callId: call.id, gateId, visitorId: call.visitorId, timestamp });
      console.log(`[CALL] Incoming call ${call.id} from gate ${gateId}`);
    });

    socket.on('call:direct-request', (data) => {
      const residentId = String(data?.residentId || '');
      const resident = getOne('SELECT id, name, apartment FROM residents WHERE id = ?', [residentId]);
      if (!resident) {
        socket.emit('call:error', { error: 'Resident not found' });
        return;
      }

      const call = openCall(socket, data, { residentId });
      const timestamp = call.startedAt;
      socket.emit('call:requested', { callId: call.id, residentId, timestamp });
      io.to(`resident:${residentId}`).emit('call:direct-incoming', {
        callId: call.id,
        residentId,
        visitorId: call.visitorId,
        residentName: resident.name,
        timestamp
      });
      console.log(`[CALL] Direct call ${call.id} to resident ${resident.name} (${residentId})`);
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
      call.answeredAt = now();
      const answeringResidentId = call.residentId || user.id;
      call.answeredBy = user.id;

      run("UPDATE call_logs SET status = 'active', answered_at = ?, resident_id = ? WHERE id = ?",
        [call.answeredAt, answeringResidentId, call.id]);

      socket.join(`call:${call.id}`);
      io.to(call.visitorSocketId).emit('call:answered', { callId: call.id });
      // Stop every other phone that was ringing for this call.
      io.to(ringRoom(call)).except(socket.id).emit('call:ended', { callId: call.id, reason: 'answered-elsewhere' });
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

      const sent = mqtt.unlockGate(call.gateId, user.id);
      if (!sent) return socket.emit('call:error', { error: 'Gate controller unreachable' });
      call.unlockedAt = now();

      io.to(call.visitorSocketId).emit('gate:unlocked', { callId: call.id });
      console.log(`[CALL] Gate ${call.gateId} unlocked by ${user.email} for call ${call.id}`);
    });

    const relay = (event, field) => socket.on(event, (data) => {
      const call = activeCalls.get(data?.callId);
      if (!call) return;
      const targetId = peerOf(call, socket.id);
      if (!targetId) return;
      io.to(targetId).emit(event, { callId: call.id, [field]: data[field] });
    });
    relay('webrtc:offer', 'offer');
    relay('webrtc:answer', 'answer');
    relay('webrtc:ice-candidate', 'candidate');

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
    endCall(callId, 'missed', 'no-answer');
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

function endCall(callId, finalStatus = 'ended', reason) {
  const call = activeCalls.get(callId);
  if (!call) return;
  clearRingTimeout(callId);

  call.status = finalStatus;
  const endedAt = now();
  const duration = call.answeredAt
    ? Math.max(0, Math.floor((new Date(endedAt) - new Date(call.answeredAt)) / 1000))
    : 0;

  run(
    'UPDATE call_logs SET status = ?, ended_at = ?, duration = ? WHERE id = ?',
    [finalStatus, endedAt, duration, callId]
  );

  const payload = reason ? { callId, reason } : { callId };
  if (call.residentSocketId) {
    io.to([call.visitorSocketId, call.residentSocketId]).emit('call:ended', payload);
  } else {
    // Never answered: the phones that are still ringing need to stop too.
    io.to([call.visitorSocketId, ringRoom(call)]).emit('call:ended', payload);
  }

  activeCalls.delete(callId);
  console.log(`[CALL] Call ${callId} ${finalStatus}, duration: ${duration}s`);
}

function getIO() {
  return io;
}

module.exports = { initWebRTC, getIO, activeCalls };
