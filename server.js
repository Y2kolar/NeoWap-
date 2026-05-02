const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Проверка сервера в браузере
app.get("/", (req, res) => {
  res.send("NeoWAP server online");
});

// Комнаты и количество людей
const rooms = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", (room) => {
    if (!room) return;

    // выйти из старых комнат, кроме собственной socket.id
    for (const r of socket.rooms) {
      if (r !== socket.id) {
        socket.leave(r);

        if (rooms[r]) {
          rooms[r] = Math.max(0, rooms[r] - 1);
          io.to(r).emit("system", `👤 Кто-то вышел. Сейчас в комнате: ${rooms[r]}`);
        }
      }
    }

    socket.join(room);
    socket.currentRoom = room;

    if (!rooms[room]) rooms[room] = 0;
    rooms[room]++;

    io.to(room).emit("system", `👤 Кто-то вошёл. Сейчас в комнате: ${rooms[room]}`);
  });

  socket.on("message", (data) => {
    if (!data || !data.room || !data.text || !data.user) return;

    io.to(data.room).emit("message", {
      user: data.user,
      text: data.text,
      room: data.room,
      time: Date.now()
    });
  });

  socket.on("disconnect", () => {
    const room = socket.currentRoom;

    if (room && rooms[room]) {
      rooms[room] = Math.max(0, rooms[room] - 1);
      io.to(room).emit("system", `👤 Кто-то вышел. Сейчас в комнате: ${rooms[room]}`);
    }

    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`NeoWAP server running on port ${PORT}`);
});
