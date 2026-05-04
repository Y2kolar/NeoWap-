const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { initDb } = require("./src/db");
const sockets = require("./src/sockets");
const routes = require("./src/routes");
const sabrinaRoutes = require("./src/sabrinaRoutes");
const sabrinaAi = require("./src/sabrinaAi");

const app = express();

app.use(express.json({ limit: "1mb" }));

/* CORS + OPTIONS fix */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

/* health check */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "NeoWAP",
    time: new Date().toISOString()
  });
});

/* main API routes */
routes.setupRoutes(app, {
  getRoomsOnline: sockets.getRoomsOnline
});

/* Sabrina routes */
sabrinaRoutes.setupSabrinaRoutes(app);
sabrinaAi.setupSabrinaAiRoutes(app);

/* static files */
app.use(express.static(__dirname));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"]
  }
});

sockets.setupSockets(io);

const PORT = process.env.PORT || 8080;

initDb()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log("Database ready");
      console.log(`NeoWAP server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("SERVER START ERROR:", e);
    process.exit(1);
  });
