var express = require('express');
var http = require('http');
var WebSocket = require('ws');
var webpush = require('web-push');
var path = require('path');

var VAPID_PUBLIC_KEY = 'BDFDyyfTxKnrsh-ndwLFkXXRiCzfZ8YJVAAjoILQZVdxXRRHZjXG8enyPpU5Zjm2KDFVpdrH_cc_mYgNpQNKDkA';
var VAPID_PRIVATE_KEY = 'RtocTrHnJHOT9Xvhgzz4oGgyHJ2I2JXbH9TQAzzs-k0';

webpush.setVapidDetails(
  'mailto:chat@example.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/vapid-public-key', function(req, res) {
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/subscribe', function(req, res) {
  var sub = req.body;
  if (!sub || !sub.endpoint) { res.status(400).json({ error: 'invalid' }); return; }
  var userId = sub.userId;
  pushSubscriptions[userId] = sub;
  res.json({ ok: true });
});

function sendPushNotification(userId, data) {
  var sub = pushSubscriptions[userId];
  if (!sub) return;
  webpush.sendNotification(sub, JSON.stringify(data)).catch(function(err) {
    console.log('Push failed for ' + userId + ': ' + err.message);
  });
}

var users = {};
var sockets = {};
var pushSubscriptions = {};
var messages = [];
var idCounter = 0;

function generateId() {
  idCounter++;
  return 'user_' + idCounter + '_' + Date.now();
}

function generateColor() {
  var colors = ['#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6','#a855f7','#d946ef'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function getTimeString() {
  var now = new Date();
  var h = now.getHours();
  var m = now.getMinutes();
  if (h < 10) h = '0' + h;
  if (m < 10) m = '0' + m;
  return h + ':' + m;
}

function getOnlineUsersList() {
  var list = [];
  for (var id in users) {
    list.push({ id: users[id].id, name: users[id].name, color: users[id].color, avatar: users[id].avatar });
  }
  return list;
}

function broadcast(data, excludeId) {
  var msg = JSON.stringify(data);
  for (var id in sockets) {
    if (id !== excludeId && sockets[id].readyState === 1) {
      try { sockets[id].send(msg); } catch (e) {}
    }
  }
}

function broadcastPush(data, excludeId) {
  for (var id in pushSubscriptions) {
    if (id !== excludeId) {
      sendPushNotification(id, data);
    }
  }
}

wss.on('connection', function(ws) {
  var userId = null;

  ws.on('message', function(raw) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.type === 'login') {
      var name = (data.name || '').trim().substring(0, 20);
      if (!name) return;

      userId = generateId();
      var color = generateColor();
      var avatar = name.charAt(0).toUpperCase();

      users[userId] = { id: userId, name: name, color: color, avatar: avatar };
      sockets[userId] = ws;

      ws.send(JSON.stringify({
        type: 'your_info',
        user: { id: userId, name: name, color: color, avatar: avatar }
      }));

      ws.send(JSON.stringify({
        type: 'previous_messages',
        messages: messages.slice(-50)
      }));

      ws.send(JSON.stringify({
        type: 'online_users',
        onlineUsers: getOnlineUsersList()
      }));

      broadcast({
        type: 'user_joined',
        user: { id: userId, name: name, color: color, avatar: avatar },
        onlineUsers: getOnlineUsersList()
      }, userId);

      console.log('User connected: ' + name + ' (' + userId + ')');
    }

    else if (data.type === 'send_message') {
      if (!userId || !users[userId]) return;
      var text = (data.text || '').trim().substring(0, 500);
      if (!text) return;

      var msg = {
        id: messages.length + 1,
        userId: userId,
        username: users[userId].name,
        color: users[userId].color,
        avatar: users[userId].avatar,
        text: text,
        time: getTimeString()
      };
      messages.push(msg);
      if (messages.length > 200) messages = messages.slice(-100);

      broadcast({ type: 'new_message', message: msg });

      broadcastPush({
        title: 'محادثة فورية',
        username: msg.username,
        text: msg.text
      }, userId);
    }

    else if (data.type === 'typing') {
      if (!userId || !users[userId]) return;
      broadcast({ type: 'user_typing', username: users[userId].name }, userId);
    }

    else if (data.type === 'stop_typing') {
      if (!userId || !users[userId]) return;
      broadcast({ type: 'user_stopped_typing', username: users[userId].name }, userId);
    }
  });

  ws.on('close', function() {
    if (userId && users[userId]) {
      var username = users[userId].name;
      delete sockets[userId];
      delete users[userId];

      broadcast({
        type: 'user_left',
        username: username,
        onlineUsers: getOnlineUsersList()
      });

      console.log('User disconnected: ' + username + ' (' + userId + ')');
    }
  });

  ws.on('error', function() {});
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log('Chat server running on port ' + PORT);
});