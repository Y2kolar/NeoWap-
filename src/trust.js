function getTrustLevel(score) {
  const value = Number(score) || 0;

  if (value >= 91) return "проверенный";
  if (value >= 71) return "спокойный";
  if (value >= 41) return "обычный";
  if (value >= 21) return "новый";

  return "мутный";
}

function getPrivateWarningLevel(score) {
  const value = Number(score) || 0;

  if (value <= 20) return "blocked";
  if (value <= 40) return "soft";

  return "none";
}

function clampTrust(score) {
  const value = Number(score) || 0;

  return Math.max(0, Math.min(100, value));
}

module.exports = {
  getTrustLevel,
  getPrivateWarningLevel,
  clampTrust
};
