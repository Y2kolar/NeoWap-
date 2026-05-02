function getEarnedStatus(count) {
  const messages = Number(count) || 0;

  if (messages >= 10000) return "Rockstar 🦊";
  if (messages >= 1000) return "Star ⭐";
  if (messages >= 500) return "Moon 🌕";
  if (messages >= 200) return "Whisper 🌓";
  if (messages > 10) return "Silent 🌒";

  return "No body 🌑";
}

function getActiveStatus(user) {
  if (!user) return "No body 🌑";

  return (
    user.manual_status ||
    user.paid_status ||
    getEarnedStatus(user.messages_count || 0)
  );
}

module.exports = {
  getEarnedStatus,
  getActiveStatus
};
