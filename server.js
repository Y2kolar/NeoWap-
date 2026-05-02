const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { initDb } = require("./src/db");
const sockets = require("./src/sockets");
const routes = require("./src/routes");

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(200);

  next();
});

routes.setupRoutes(app, {
  getRoomsOnline: sockets.getRoomsOnline
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

sockets.setupSockets(io);

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`NeoWAP server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
