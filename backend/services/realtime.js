// Thin wrapper so routes can push updates to the control room without importing socket.io.
let io = null;

function attach(server) {
  const { Server } = require('socket.io');
  io = new Server(server, { cors: { origin: '*' } });

  io.on('connection', socket => {
    socket.join('control');
    socket.on('disconnect', () => {});
  });
  return io;
}

function emit(event, payload) {
  if (io) io.to('control').emit(event, payload);
}

module.exports = { attach, emit };
