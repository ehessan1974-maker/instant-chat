var express = require('express');
var http = require('http');
var WebSocket = require('ws');
var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server });
var users = {};
var messages = [];
var userIdCounter = 1;
app.get('/', function(req, res) {
  res.send('<h1>Chat Server Running!</h1>');
});
function getRandomColor() {
  var colors = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#14b8a6','#f97316','#06b6d4','#84cc16','#e11d48'];
  return colors[Math.floor(Math.random() * colors.length)];
}
function getUserList() {
  var list = [];
  for (var id in users) { list.push(users[id]); }
  return list;
}
function sendToAll(data) {
  var msg = JSON.stringify(data);
  for (var id in users) {
    if (users[id].ws.readyState === 1) users[id].ws.send(msg);
  }
}
function sendTo(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}
function getTime() {
  var d = new Date();
  var h = d.getHours(); var m = d.getMinutes();
  if (h < 10) h = '0' + h;
  if (m < 10) m = '0' + m;
  return h + ':' + m;
}
wss.on('connection', function(ws) {
  var myId = '' + userIdCounter++;
  ws.on('message', function(raw) {
    var data;
    try { data = JSON.parse(raw); } catch(e) { return; }
    if (data.type === 'login') {
      var name = data.name || 'User';
      users[myId] = { id: myId, name: name, color: getRandomColor(), avatar: name.charAt(0).toUpperCase(), ws: ws };
      sendTo(ws, { type: 'previous_messages', messages: messages.slice(-100) });
      sendTo(ws, { type: 'your_info', user: users[myId] });
      sendToAll({ type: 'user_joined', user: users[myId], onlineUsers: getUserList() });
    }
    else if (data.type === 'send_message') {
      var user = users[myId];
      if (!user) return;
      var message = { id: Date.now() + Math.random(), userId: myId, username: user.name, avatar: user.avatar, color: user.color, text: data.text || '', time: getTime() };
      messages.push(message);
      if (messages.length > 500) messages = messages.slice(-200);
      sendToAll({ type: 'new_message', message: message });
    }
    else if (data.type === 'typing') {
      var u = users[myId];
      if (u) sendToAll({ type: 'user_typing', username: u.name });
    }
    else if (data.type === 'stop_typing') {
      sendToAll({ type: 'user_stopped_typing' });
    }
  });
  ws.on('close', function() {
    var user = users[myId];
    if (user) {
      delete users[myId];
      sendToAll({ type: 'user_left', userId: myId, username: user.name, onlineUsers: getUserList() });
    }
  });
  ws.on('error', function() {});
});
var PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  console.log('Chat server running on port ' + PORT);
});
