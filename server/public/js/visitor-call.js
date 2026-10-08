// Visitor side of a call, shared by the gate kiosk (gate.html) and the page
// behind a resident's QR code (call.html). Each page passes the event that
// starts its call and its idle wording; the call flow is the same for both.
//
// The page must have #call-btn, #call-btn-text, #status-text, #video-container
// and #remote-video. #error-text is optional; without it errors go in the status.
(function () {
  var ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  function $(id) { return document.getElementById(id); }

  window.createVisitorCall = function (options) {
    var socket = io();
    var visitorId = 'visitor-' + Math.random().toString(36).slice(2, 10);
    // idle -> starting (asking for camera, waiting for a call id) -> ringing -> active
    var state = 'idle';
    var callId = null;
    var localStream = null;
    var peerConnection = null;

    function setStatus(text) { $('status-text').textContent = text; }

    // Clearing an error must not blank the status on pages that share the line.
    function showError(text) {
      if ($('error-text')) $('error-text').textContent = text;
      else if (text) setStatus(text);
    }

    function setButton(label, cls) {
      var btn = $('call-btn');
      btn.classList.remove('ringing', 'in-call');
      if (cls) btn.classList.add(cls);
      $('call-btn-text').textContent = label;
    }

    function reset() {
      state = 'idle';
      callId = null;
      if (peerConnection) { peerConnection.close(); peerConnection = null; }
      if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
      $('video-container').classList.remove('active');
      setButton(options.idleLabel);
      setStatus(options.idleStatus);
    }

    async function start() {
      state = 'starting';
      setButton('Calling...', 'ringing');
      setStatus('Connecting to resident...');
      showError('');

      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (e) {
        reset();
        setStatus('Camera/mic access denied');
        if ($('error-text')) showError('Please allow camera and microphone access.');
        return;
      }
      // The visitor may have given up while the browser asked for the camera.
      if (state !== 'starting') return;

      var payload = options.request();
      payload.visitorId = visitorId;
      socket.emit(options.requestEvent, payload);
    }

    function end() {
      if (callId) socket.emit('call:end', { callId: callId });
      reset();
    }

    // A second tap while the first is still setting up would ring twice.
    function toggle() {
      if (state === 'idle') start();
      else if (state !== 'starting') end();
    }

    socket.on('call:requested', function (data) {
      if (state !== 'starting') return;
      state = 'ringing';
      callId = data.callId;
      setStatus('Ringing...');
    });

    socket.on('call:error', function (data) {
      // Only an error about our own call setup resets the page; once connected,
      // a stray error should not hang up a working call.
      if (state === 'active') return;
      reset();
      showError(data.error || 'Call failed');
    });

    socket.on('call:answered', async function (data) {
      if (data.callId !== callId || !localStream) return;
      state = 'active';
      setButton('End Call', 'in-call');
      setStatus('Connected!');
      showError('');

      peerConnection = new RTCPeerConnection(ICE_SERVERS);
      localStream.getTracks().forEach(function (t) { peerConnection.addTrack(t, localStream); });

      peerConnection.ontrack = function (e) {
        $('remote-video').srcObject = e.streams[0];
        $('video-container').classList.add('active');
      };
      peerConnection.onicecandidate = function (e) {
        if (e.candidate) socket.emit('webrtc:ice-candidate', { callId: callId, candidate: e.candidate });
      };

      var offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc:offer', { callId: callId, offer: offer });
    });

    socket.on('webrtc:answer', function (data) {
      if (data.callId !== callId || !peerConnection) return;
      peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer))
        .catch(function (e) { console.error('[call] remote description', e); });
    });

    socket.on('webrtc:ice-candidate', function (data) {
      if (data.callId !== callId || !peerConnection) return;
      peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
        .catch(function (e) { console.error('[call] ICE candidate', e); });
    });

    socket.on('call:ended', function (data) {
      if (data.callId === callId) reset();
    });

    socket.on('gate:unlocked', function (data) {
      if (data.callId !== callId) return;
      var unlockedCall = callId;
      setStatus('Gate unlocked!');
      setTimeout(function () {
        if (callId === unlockedCall && state === 'active') setStatus('Connected!');
      }, 3000);
    });

    // The server ends the call when this socket drops, so the page should too.
    socket.on('disconnect', function () {
      if (state !== 'idle') { reset(); showError('Connection lost. Please try again.'); }
    });

    if ($('visitor-id')) $('visitor-id').textContent = 'Visitor: ' + visitorId;
    reset();

    return { toggle: toggle, end: end };
  };
})();
