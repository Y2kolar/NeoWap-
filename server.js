const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

let rooms = {}; // комнаты

io.on("connection", (socket) => {

    console.log("user connected:", socket.id);

    // вход в комнату
    socket.on("joinRoom", (room) => {
        socket.join(room);

        if (!rooms[room]) rooms[room] = 0;
        rooms[room]++;

        io.to(room).emit("system", `👤 Пользователь вошёл (${rooms[room]})`);
    });

    // сообщение
    socket.on("message", ({ room, text, user }) => {
        io.to(room).emit("message", { user, text });
    });

    // выход
    socket.on("disconnect", () => {
        console.log("user disconnected");
    });

});

server.listen(3000, () => {
    console.log("Server running");
});
