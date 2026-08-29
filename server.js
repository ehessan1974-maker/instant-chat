const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 60000 });
const users = new Map();
const messages = [];

app.get('/', (req, res) => {
  res.send('<h1 style="text-align:center;margin-top:50px;color:#6366f1">✅ الخادم يعمل!<br><small>' + req.hostname + '</small></h1>');
});

io.on('connection', (socket) => {
  socket.on('login', (username) => {
    users.set(socket.id, { id: socket.id, name: username, color: ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#14b8a6'][Math.floor(Math.random()*8)], avatar: username.charAt(0).toUpperCase() });
    socket.emit('previous_messages', messages.slice(-100));
    io.emit('user_joined', { user: users.get(socket.id), onlineUsers: Array.from(users.values()) });
    socket.emit('online_users', Array.from(users.values()));
  });
  socket.on('send_message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    const msg = { id: Date.now() + '' + Math.random(), userId: socket.id, username: user.name, avatar: user.avatar, color: user.color, text: data.text, time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }), timestamp: Date.now() };
    messages.push(msg);
    io.emit('new_message', msg);
  });
  socket.on('typing', () => { const u = users.get(socket.id); if (u) socket.broadcast.emit('user_typing', { username: u.name }); });
  socket.on('stop_typing', () => { socket.broadcast.emit('user_stopped_typing'); });
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) { users.delete(socket.id); io.emit('user_left', { userId: socket.id, username: user.name, onlineUsers: Array.from(users.values()) }); }
  });
});

server.listen(process.env.PORT || 3001, () => console.log('✅ running'));