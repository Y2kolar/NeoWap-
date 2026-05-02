const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

app.get("/", (req, res) => {
  res.status(200).send("NeoWAP server online");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", (room) => {
    if (!room) return;

    socket.join(room);
    socket.currentRoom = room;

    rooms[room] = (rooms[room] || 0) + 1;

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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NeoWAP server running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("Railway sent SIGTERM, shutting down gracefully");
  server.close(() => {
    process.exit(0);
  });
});
