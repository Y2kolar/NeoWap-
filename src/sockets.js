const { pool } = require("./db");
const statusTools = require("./statuses");
const trustTools = require("./trust");
const userTools = require("./users");
const privateRooms = require("./privateRooms");
const adminTools = require("./admin");

const roomsOnline = {};
const roomUsers = {};
const userSockets = {};

function getEarnedStatus(count) {
  return statusTools.getEarnedStatus(count);
}

function getActiveStatus(user) {
  return statusTools.getActiveStatus(user);
}

function getTrustLevel(score) {
  return trustTools.getTrustLevel(score);
}

function getPrivateWarningLevel(score) {
  return trustTools.getPrivateWarningLevel(score);
}

async function getUserByNick(nick) {
  return userTools.getUserByNick(nick);
}

async function touchUser(nick) {
  return userTools.touchUser(nick);
}

function getRoomsOnline() {
  return roomsOnline;
}

function addUserSocket(nick, socketId) {
  if (!nick) return;

  const key = String(nick).toLowerCase();

  if (!userSockets[key]) {
    userSockets[key] = new Set();
  }

  userSockets[key].add(socketId);
}

function removeUserSocket(nick, socketId) {
  if (!nick) return;

  const key = String(nick).toLowerCase();

  if (!userSockets[key]) return;

  userSockets[key].delete(socketId);

  if (userSockets[key].size === 0) {
    delete userSockets[key];
  }
}

function emitToNick(io, nick, event, payload) {
  if (!nick) return;

  const key = String(nick).toLowerCase();
  const sockets = userSockets[key];

  if (!sockets) return;

  for (const socketId of sockets) {
    io.to(socketId).emit(event, payload);
  }
}

function emitRoomsOnline(io) {
  io.emit("roomsOnline", roomsOnline);
}

function leaveCurrentRoom(socket, io) {
  const room = socket.currentRoom;

  if (!room) return;

  socket.leave(room);

  if (roomsOnline[room]) {
    roomsOnline[room] = Math.max(0, roomsOnline[room] - 1);
  }

  if (roomUsers[room]) {
    roomUsers[room].delete(socket.id);
  }

  io.to(room).emit(
    "roomUsers",
    roomUsers[room] ? Array.from(roomUsers[room].values()) : []
  );

  emitRoomsOnline(io);
}

function setupSockets(io) {
  io.on("connection", (socket) => {
    console.log("connected", socket.id);

    socket.on("registerUser", async (data) => {
      const nick = String(data?.user || "").trim();

      if (!nick) return;

      socket.nick = nick;
      addUserSocket(nick, socket.id);

      await touchUser(nick);

      socket.emit("system", "NeoWAP: пользователь зарегистрирован в сети.");
    });

    socket.on("joinRoom", async (data) => {
      try {
        const room = data.room;
        const nick = data.user;

        if (!room || !nick) return;

        if (privateRooms.isPrivateRoom(room)) {
          const code = privateRooms.normalizePrivateCode(room);
          const allowed = await privateRooms.isPrivateMember(code, nick);

          if (!allowed) {
            socket.emit("system", "Нет доступа к этой закрытой комнате.");
            return;
          }
        }

        addUserSocket(nick, socket.id);

        if (socket.currentRoom) {
          leaveCurrentRoom(socket, io);
        }

        socket.join(room);

        socket.currentRoom = room;
        socket.nick = nick;

        roomsOnline[room] = (roomsOnline[room] || 0) + 1;

        if (!roomUsers[room]) {
          roomUsers[room] = new Map();
        }

        roomUsers[room].set(socket.id, nick);

        io.to(room).emit(
          "roomUsers",
          Array.from(roomUsers[room].values())
        );

        io.to(room).emit(
          "system",
          `👤 ${nick} вошёл в комнату`
        );

        emitRoomsOnline(io);

      } catch (e) {
        console.error("JOIN ROOM ERROR:", e);
        socket.emit("system", "Ошибка входа в комнату.");
      }
    });

    socket.on("typing", (data) => {
      if (!data || !data.room || !data.user) return;

      socket.to(data.room).emit("typing", {
        user: data.user,
        active_status: data.active_status
      });
    });

    socket.on("createPrivateInvite", async (data) => {
      try {
        const fromNick = String(data?.from || "").trim();
        const toNick = String(data?.to || "").trim();
        const requestedCode = privateRooms.normalizePrivateCode(data?.code || "");

        if (!fromNick || !toNick) {
          socket.emit("privateInviteError", "Нужно указать ник.");
          return;
        }

        if (fromNick.toLowerCase() === toNick.toLowerCase()) {
          socket.emit("privateInviteError", "Нельзя пригласить самого себя.");
          return;
        }

        const inviter = await getUserByNick(fromNick);
        const target = await getUserByNick(toNick);

        if (!inviter) {
          socket.emit("privateInviteError", "Твой аккаунт не найден.");
          return;
        }

        if (!target) {
          socket.emit("privateInviteError", "Пользователь не найден.");
          return;
        }

        const now = new Date();

        if (
          inviter.banned_forever ||
          (inviter.ban_until && new Date(inviter.ban_until) > now)
        ) {
          socket.emit("privateInviteError", "Ты не можешь приглашать в приват из-за бана.");
          return;
        }

        if (inviter.muted_until && new Date(inviter.muted_until) > now) {
          socket.emit("privateInviteError", "Во время мута нельзя приглашать в приват.");
          return;
        }

        const warningLevel = getPrivateWarningLevel(inviter.trust_score || 35);

        if (warningLevel === "blocked") {
          socket.emit(
            "privateInviteError",
            "Sabrina: пока приватные комнаты закрыты для тебя. Немного пообщайся спокойно в общих комнатах — доступ вернётся."
          );
          return;
        }

        let code = requestedCode;

        if (code) {
          const room = await privateRooms.privateRoomExists(code);

          if (!room) {
            socket.emit("privateInviteError", "Комната с таким кодом не найдена.");
            return;
          }

          const member = await privateRooms.isPrivateMember(code, fromNick);

          if (!member) {
            socket.emit("privateInviteError", "Ты не участник этой комнаты.");
            return;
          }

        } else {
          code = privateRooms.makePrivateCode();

          await pool.query(
            `INSERT INTO private_rooms (code, created_by, invited_nick)
             VALUES ($1, $2, $3)`,
            [code, fromNick, toNick]
          );

          await privateRooms.addPrivateMember(code, fromNick, "owner");
        }

        const alreadyMember = await privateRooms.isPrivateMember(code, toNick);

        if (alreadyMember) {
          socket.emit("privateInviteError", "Этот пользователь уже участник комнаты.");
          return;
        }

        const invite = await pool.query(
          `INSERT INTO private_invites (code, from_nick, to_nick, warning_level)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [code, fromNick, toNick, warningLevel]
        );

        const payload = {
          ...invite.rows[0],
          from_status: getActiveStatus(inviter),
          from_trust_level: getTrustLevel(inviter.trust_score || 35)
        };

        socket.emit("privateInviteCreated", payload);
        emitToNick(io, toNick, "privateInvite", payload);

      } catch (e) {
        console.error("CREATE PRIVATE INVITE ERROR:", e);
        socket.emit("privateInviteError", "Ошибка создания приглашения.");
      }
    });

    socket.on("acceptPrivateInvite", async (data) => {
      try {
        const code = privateRooms.normalizePrivateCode(data?.code || "");
        const nick = String(data?.user || "").trim();

        if (!code || !nick) return;

        const result = await pool.query(
          `SELECT *
           FROM private_invites
           WHERE code = $1
           AND lower(to_nick) = lower($2)
           AND status = 'pending'
           LIMIT 1`,
          [code, nick]
        );

        const invite = result.rows[0];

        if (!invite) {
          socket.emit("privateInviteError", "Приглашение не найдено или уже закрыто.");
          return;
        }

        await pool.query(
          `UPDATE private_invites
           SET status = 'accepted',
               accepted_at = NOW()
           WHERE id = $1`,
          [invite.id]
        );

        await privateRooms.addPrivateMember(code, nick, "member");

        const room = privateRooms.privateRoomId(code);

        socket.emit("privateInviteAccepted", {
          code,
          room,
          from: invite.from_nick,
          to: invite.to_nick
        });

        emitToNick(io, invite.from_nick, "privateInviteAccepted", {
          code,
          room,
          from: invite.from_nick,
          to: invite.to_nick
        });

      } catch (e) {
        console.error("ACCEPT PRIVATE INVITE ERROR:", e);
        socket.emit("privateInviteError", "Ошибка принятия приглашения.");
      }
    });

    socket.on("declinePrivateInvite", async (data) => {
      try {
        const code = privateRooms.normalizePrivateCode(data?.code || "");
        const nick = String(data?.user || "").trim();

        if (!code || !nick) return;

        const result = await pool.query(
          `UPDATE private_invites
           SET status = 'declined',
               declined_at = NOW()
           WHERE code = $1
           AND lower(to_nick) = lower($2)
           AND status = 'pending'
           RETURNING *`,
          [code, nick]
        );

        const invite = result.rows[0];

        if (!invite) return;

        socket.emit("privateInviteDeclined", invite);

        emitToNick(io, invite.from_nick, "privateInviteDeclined", {
          code,
          from: invite.from_nick,
          to: invite.to_nick
        });

      } catch (e) {
        console.error("DECLINE PRIVATE INVITE ERROR:", e);
      }
    });

    socket.on("joinPrivateByCode", async (data) => {
      try {
        const code = privateRooms.normalizePrivateCode(data?.code || "");
        const nick = String(data?.user || "").trim();

        if (!code || !nick) {
          socket.emit("privateInviteError", "Укажи код комнаты.");
          return;
        }

        const room = await privateRooms.privateRoomExists(code);

        if (!room) {
          socket.emit("privateInviteError", "Комната не найдена.");
          return;
        }

        const member = await privateRooms.isPrivateMember(code, nick);

        if (!member) {
          socket.emit("privateInviteError", "Нет доступа. Нужно приглашение в эту комнату.");
          return;
        }

        socket.emit("privateJoinedByCode", {
          code,
          room: privateRooms.privateRoomId(code)
        });

      } catch (e) {
        console.error("JOIN PRIVATE BY CODE ERROR:", e);
        socket.emit("privateInviteError", "Ошибка входа по коду.");
      }
    });

    socket.on("message", async (data) => {
      try {
        const room = String(data.room).trim();
        const userNick = String(data.user).trim();
        const text = String(data.text).trim();

        if (!room || !userNick || !text) return;

        if (text.startsWith("/")) {
          const handled = await adminTools.handleAdminCommand(socket, data, io);
          if (handled) return;
        }

        const user = await getUserByNick(userNick);

        if (!user) return;

        const now = new Date();

        if (user.banned_forever) {
          socket.emit("system", "Ты забанен навсегда.");
          return;
        }

        if (user.ban_until && new Date(user.ban_until) > now) {
          socket.emit("system", "Ты временно забанен.");
          return;
        }

        if (user.muted_until && new Date(user.muted_until) > now) {
          socket.emit("system", "У тебя временный мут.");
          return;
        }

        if (privateRooms.isPrivateRoom(room)) {
          const code = privateRooms.normalizePrivateCode(room);
          const allowed = await privateRooms.isPrivateMember(code, userNick);

          if (!allowed) {
            socket.emit("system", "Нет доступа к этой закрытой комнате.");
            return;
          }
        }

        await pool.query(
          `INSERT INTO messages (room, user_nick, text)
           VALUES ($1, $2, $3)`,
          [room, userNick, text]
        );

        const updated = await pool.query(
          `UPDATE users
           SET messages_count = messages_count + 1,
               last_seen = NOW(),
               trust_score = LEAST(
                 100,
                 GREATEST(
                   0,
                   COALESCE(trust_score, 35) + CASE WHEN messages_count % 50 = 0 THEN 1 ELSE 0 END
                 )
               )
           WHERE lower(nick) = lower($1)
           RETURNING messages_count, paid_status, manual_status, trust_score`,
          [userNick]
        );

        const updatedUser = updated.rows[0];

        const activeStatus =
          updatedUser.manual_status ||
          updatedUser.paid_status ||
          getEarnedStatus(updatedUser.messages_count);

        io.to(room).emit("message", {
          user: userNick,
          text,
          room,
          active_status: activeStatus,
          messages_count: updatedUser.messages_count,
          trust_level: getTrustLevel(updatedUser.trust_score),
          trust_score: updatedUser.trust_score
        });

      } catch (e) {
        console.error("SOCKET MESSAGE ERROR:", e);
      }
    });

    socket.on("disconnect", () => {
      if (socket.nick) {
        removeUserSocket(socket.nick, socket.id);
      }

      if (socket.currentRoom) {
        leaveCurrentRoom(socket, io);
      }

      console.log("disconnect", socket.id);
    });
  });
}

module.exports = {
  setupSockets,
  getRoomsOnline
};
