const { pool } = require("./db");

function makePrivateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function normalizePrivateCode(code) {
  return String(code || "")
    .replace("private:", "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function privateRoomId(code) {
  return "private:" + normalizePrivateCode(code);
}

function isPrivateRoom(room) {
  return String(room || "").startsWith("private:");
}

async function privateRoomExists(code) {
  const cleanCode = normalizePrivateCode(code);

  if (!cleanCode) return null;

  const result = await pool.query(
    `SELECT *
     FROM private_rooms
     WHERE code = $1
     AND is_active = true
     LIMIT 1`,
    [cleanCode]
  );

  return result.rows[0] || null;
}

async function addPrivateMember(code, nick, role = "member") {
  const cleanCode = normalizePrivateCode(code);
  const cleanNick = String(nick || "").trim();
  const cleanRole = String(role || "member").trim();

  if (!cleanCode || !cleanNick) return null;

  const result = await pool.query(
    `INSERT INTO private_room_members (code, nick, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (code, nick)
     DO UPDATE SET role = EXCLUDED.role
     RETURNING *`,
    [cleanCode, cleanNick, cleanRole]
  );

  return result.rows[0] || null;
}

async function getPrivateMember(code, nick) {
  const cleanCode = normalizePrivateCode(code);
  const cleanNick = String(nick || "").trim();

  if (!cleanCode || !cleanNick) return null;

  const result = await pool.query(
    `SELECT *
     FROM private_room_members
     WHERE code = $1
     AND lower(nick) = lower($2)
     LIMIT 1`,
    [cleanCode, cleanNick]
  );

  return result.rows[0] || null;
}

async function isPrivateMember(code, nick) {
  const member = await getPrivateMember(code, nick);
  return Boolean(member);
}

async function isPrivateOwner(code, nick) {
  const member = await getPrivateMember(code, nick);

  if (!member) return false;

  return String(member.role || "").toLowerCase() === "owner";
}

async function getPrivateMembers(code) {
  const cleanCode = normalizePrivateCode(code);

  if (!cleanCode) return [];

  const result = await pool.query(
    `SELECT nick, role, joined_at
     FROM private_room_members
     WHERE code = $1
     ORDER BY
       CASE WHEN role = 'owner' THEN 0 ELSE 1 END,
       joined_at ASC`,
    [cleanCode]
  );

  return result.rows;
}

async function removePrivateMember(code, nick) {
  const cleanCode = normalizePrivateCode(code);
  const cleanNick = String(nick || "").trim();

  if (!cleanCode || !cleanNick) return null;

  const result = await pool.query(
    `DELETE FROM private_room_members
     WHERE code = $1
     AND lower(nick) = lower($2)
     RETURNING *`,
    [cleanCode, cleanNick]
  );

  return result.rows[0] || null;
}

async function closePrivateRoom(code) {
  const cleanCode = normalizePrivateCode(code);

  if (!cleanCode) return null;

  await pool.query(
    `UPDATE private_rooms
     SET is_active = false,
         closed_at = NOW()
     WHERE code = $1`,
    [cleanCode]
  );

  return {
    code: cleanCode,
    is_active: false
  };
}

async function createPrivateReport(code, reporterNick, targetNick, reason) {
  const cleanCode = normalizePrivateCode(code);
  const reporter = String(reporterNick || "").trim();
  const target = String(targetNick || "").trim();
  const cleanReason = String(reason || "").trim() || "без причины";

  if (!cleanCode || !reporter || !target) {
    throw new Error("PRIVATE REPORT: missing code, reporter or target");
  }

  const result = await pool.query(
    `INSERT INTO private_reports (
       code,
       reporter_nick,
       target_nick,
       reason,
       status,
       review_required
     )
     VALUES ($1, $2, $3, $4, 'pending', true)
     RETURNING *`,
    [cleanCode, reporter, target, cleanReason]
  );

  return result.rows[0];
}

async function getRecentPrivateReports(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));

  const result = await pool.query(
    `SELECT *
     FROM private_reports
     ORDER BY id DESC
     LIMIT $1`,
    [safeLimit]
  );

  return result.rows;
}

async function markPrivateReportStatus(id, status, notes = "") {
  const reportId = Number(id);
  const cleanStatus = String(status || "").trim();
  const cleanNotes = String(notes || "").trim();

  if (!reportId || !cleanStatus) return null;

  const result = await pool.query(
    `UPDATE private_reports
     SET status = $1,
         ai_notes = $2,
         processed_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [cleanStatus, cleanNotes, reportId]
  );

  return result.rows[0] || null;
}

async function createPrivateInviteRequest(code, fromNick, toNick, approvers) {
  const cleanCode = normalizePrivateCode(code);
  const cleanFrom = String(fromNick || "").trim();
  const cleanTo = String(toNick || "").trim();

  const cleanApprovers = Array.from(
    new Set(
      (approvers || [])
        .map((n) => String(n || "").trim())
        .filter(Boolean)
    )
  );

  if (!cleanCode || !cleanFrom || !cleanTo) {
    throw new Error("PRIVATE INVITE REQUEST: missing code, fromNick or toNick");
  }

  const requestResult = await pool.query(
    `INSERT INTO private_invite_requests (
       code,
       from_nick,
       to_nick,
       status,
       approvals_required,
       approvals_count
     )
     VALUES ($1, $2, $3, 'pending_approval', $4, 0)
     RETURNING *`,
    [cleanCode, cleanFrom, cleanTo, cleanApprovers.length]
  );

  const request = requestResult.rows[0];

  for (const approver of cleanApprovers) {
    await pool.query(
      `INSERT INTO private_invite_request_votes (
         request_id,
         approver_nick,
         status
       )
       VALUES ($1, $2, 'pending')
       ON CONFLICT (request_id, approver_nick) DO NOTHING`,
      [request.id, approver]
    );
  }

  return {
    request,
    approvers: cleanApprovers
  };
}

async function getPendingInviteApprovalsForNick(nick) {
  const cleanNick = String(nick || "").trim();

  if (!cleanNick) return [];

  const result = await pool.query(
    `SELECT r.*
     FROM private_invite_requests r
     JOIN private_invite_request_votes v
     ON v.request_id = r.id
     WHERE lower(v.approver_nick) = lower($1)
     AND v.status = 'pending'
     AND r.status = 'pending_approval'
     ORDER BY r.id DESC
     LIMIT 20`,
    [cleanNick]
  );

  return result.rows;
}

async function votePrivateInviteRequest(requestId, approverNick, vote) {
  const id = Number(requestId);
  const cleanApprover = String(approverNick || "").trim();
  const cleanVote = vote === "approved" ? "approved" : "declined";

  if (!id || !cleanApprover) {
    return {
      ok: false,
      error: "Некорректный запрос согласования."
    };
  }

  const voteResult = await pool.query(
    `UPDATE private_invite_request_votes
     SET status = $1,
         responded_at = NOW()
     WHERE request_id = $2
     AND lower(approver_nick) = lower($3)
     AND status = 'pending'
     RETURNING *`,
    [cleanVote, id, cleanApprover]
  );

  if (!voteResult.rows[0]) {
    return {
      ok: false,
      error: "Запрос уже обработан или не найден."
    };
  }

  const requestResult = await pool.query(
    `SELECT *
     FROM private_invite_requests
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  const request = requestResult.rows[0];

  if (!request || request.status !== "pending_approval") {
    return {
      ok: false,
      error: "Запрос уже закрыт."
    };
  }

  if (cleanVote === "declined") {
    const updated = await pool.query(
      `UPDATE private_invite_requests
       SET status = 'declined',
           declined_by = $1,
           resolved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [cleanApprover, id]
    );

    return {
      ok: true,
      final: true,
      status: "declined",
      request: updated.rows[0]
    };
  }

  const votes = await pool.query(
    `SELECT status, approver_nick
     FROM private_invite_request_votes
     WHERE request_id = $1`,
    [id]
  );

  const approvedVotes = votes.rows.filter((v) => v.status === "approved");
  const pendingVotes = votes.rows.filter((v) => v.status === "pending");

  await pool.query(
    `UPDATE private_invite_requests
     SET approvals_count = $1,
         approved_by = $2
     WHERE id = $3`,
    [
      approvedVotes.length,
      approvedVotes.map((v) => v.approver_nick).join(", "),
      id
    ]
  );

  if (pendingVotes.length > 0) {
    const fresh = await pool.query(
      `SELECT *
       FROM private_invite_requests
       WHERE id = $1
       LIMIT 1`,
      [id]
    );

    return {
      ok: true,
      final: false,
      status: "waiting",
      request: fresh.rows[0]
    };
  }

  const updated = await pool.query(
    `UPDATE private_invite_requests
     SET status = 'approved',
         approvals_count = $1,
         approved_by = $2,
         resolved_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [
      approvedVotes.length,
      approvedVotes.map((v) => v.approver_nick).join(", "),
      id
    ]
  );

  return {
    ok: true,
    final: true,
    status: "approved",
    request: updated.rows[0]
  };
}

module.exports = {
  makePrivateCode,
  normalizePrivateCode,
  privateRoomId,
  isPrivateRoom,
  addPrivateMember,
  getPrivateMember,
  isPrivateMember,
  isPrivateOwner,
  getPrivateMembers,
  removePrivateMember,
  privateRoomExists,
  closePrivateRoom,
  createPrivateReport,
  getRecentPrivateReports,
  markPrivateReportStatus,
  createPrivateInviteRequest,
  getPendingInviteApprovalsForNick,
  votePrivateInviteRequest
};
