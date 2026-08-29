/*
  === خادم المحادثة الفورية ===
  تشغيل: node chat-server.js
  يتطلب: npm install socket.io express
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// خدمة ملف HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'chat.html'));
});

// تخزين المستخدمين والرسائل في الذاكرة
const users = new Map();
const messages = [];

io.on('connection', (socket) => {
  console.log('👤 مستخدم جديد متصل:', socket.id);

  // تسجيل الدخول
  socket.on('login', (username) => {
    users.set(socket.id, {
      id: socket.id,
      name: username,
      color: getRandomColor(),
      avatar: username.charAt(0).toUpperCase(),
      joinedAt: new Date().toISOString()
    });
    
    console.log(`✅ ${username} انضم للمحادثة`);
    
    // إرسال رسائل سابقة للمستخدم الجديد
    socket.emit('previous_messages', messages.slice(-50));
    
    // إبلاغ الجميع بالمستخدم الجديد
    io.emit('user_joined', {
      user: users.get(socket.id),
      onlineUsers: Array.from(users.values())
    });
    
    // إرسال قائمة المستخدمين المتصلين
    socket.emit('online_users', Array.from(users.values()));
  });

  // استقبال رسالة جديدة
  socket.on('send_message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const message = {
      id: Date.now() + Math.random(),
      userId: socket.id,
      username: user.name,
      avatar: user.avatar,
      color: user.color,
      text: data.text,
      time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    };

    messages.push(message);
    
    // بث الرسالة للجميع
    io.emit('new_message', message);
    console.log(`💬 ${user.name}: ${data.text}`);
  });

  // كتابة (أحد يكتب...)
  socket.on('typing', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.broadcast.emit('user_typing', { username: user.name });
    }
  });

  // إيقاف الكتابة
  socket.on('stop_typing', () => {
    socket.broadcast.emit('user_stopped_typing');
  });

  // انقطاع الاتصال
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`❌ ${user.name} غادر المحادثة`);
      users.delete(socket.id);
      io.emit('user_left', {
        userId: socket.id,
        username: user.name,
        onlineUsers: Array.from(users.values())
      });
    }
  });
});

function getRandomColor() {
  const colors = [
    '#6366f1', '#ec4899', '#f59e0b', '#10b981', 
    '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6',
    '#f97316', '#06b6d4', '#84cc16', '#e11d48'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
  🚀 ================================`);
  console.log(`     خادم المحادثة يعمل!`);
  console.log(`     افتح المتصفح على:`);
  console.log(`     http://localhost:${PORT}`);
  console.log(`  🚀 ================================
`);
});
