const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const FIELD_CONFIG = [
  { key: "forest", name: "고요한 숲", short: "숲", color: "#7fd07b" },
  { key: "village", name: "시작의 마을", short: "마을", color: "#f0b26d" },
  { key: "lake", name: "은빛 호수", short: "호수", color: "#85d7ff" },
  { key: "ruins", name: "잃어버린 유적지", short: "유적", color: "#ccb085" },
  { key: "coast", name: "파일섬 해안가", short: "해안", color: "#9ee4ff" },
];

const DIGIMON_CONFIG = {
  shiramon: { key: "shiramon", name: "쉬라몬" },
  agumon: { key: "agumon", name: "아구몬" },
  palmon: { key: "palmon", name: "팔몬" },
  tentomon: { key: "tentomon", name: "텐타몬" },
  papimon: { key: "papimon", name: "파피몬" },
};

const SPECIAL_CONFIG = {
  double_digivolve: { key: "double_digivolve", name: "더블 디지볼브" },
  digiscan: { key: "digiscan", name: "디지스캔" },
  file_crash: { key: "file_crash", name: "파일 크래시" },
};

const CARD_ART_PLAN = {
  forest: ["palmon","shiramon","agumon","tentomon","papimon","palmon","agumon","papimon","tentomon"],
  village: ["agumon","palmon","tentomon","shiramon","papimon","agumon","shiramon","tentomon","papimon"],
  lake: ["shiramon","papimon","agumon","tentomon","palmon","shiramon","agumon","palmon","papimon"],
  ruins: ["tentomon","agumon","palmon","shiramon","papimon","tentomon","palmon","shiramon","agumon"],
  coast: ["papimon","shiramon","agumon","palmon","tentomon","papimon","shiramon","agumon","palmon"],
};

const SPECIAL_POSITIONS = {
  "forest-1": "double_digivolve",
  "village-1": "double_digivolve",
  "lake-2": "digiscan",
  "coast-2": "digiscan",
  "ruins-3": "file_crash",
};

function createCardPool() {
  const cards = [];
  for (const field of FIELD_CONFIG) {
    for (let power = 1; power <= 9; power += 1) {
      const position = `${field.key}-${power}`;
      const digimonKey = CARD_ART_PLAN[field.key][power - 1];
      const specialKey = SPECIAL_POSITIONS[position] || null;
      cards.push({
        id: `card_${position}_${specialKey || digimonKey}`,
        fieldKey: field.key,
        power,
        type: specialKey ? "special" : "normal",
        effectKey: specialKey,
        specialKey,
        digimonKey,
        name: specialKey ? SPECIAL_CONFIG[specialKey].name : DIGIMON_CONFIG[digimonKey].name,
      });
    }
  }
  return cards;
}
const CARD_POOL = createCardPool();

function shuffle(source) {
  const arr = source.map((item) => ({ ...item }));
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sortCards(a, b) {
  const fieldIndexA = FIELD_CONFIG.findIndex((field) => field.key === a.fieldKey);
  const fieldIndexB = FIELD_CONFIG.findIndex((field) => field.key === b.fieldKey);
  if (fieldIndexA !== fieldIndexB) return fieldIndexA - fieldIndexB;
  if (a.power !== b.power) return a.power - b.power;
  return a.id.localeCompare(b.id);
}

function createPlayerGameState(roomPlayer, deckCards) {
  return {
    id: roomPlayer.id,
    nickname: roomPlayer.nickname,
    deck: deckCards,
    hand: [],
    board: Object.fromEntries(FIELD_CONFIG.map((field) => [field.key, []])),
    pendingTransfer: [],
    pendingPlay: [],
    flags: { doubleNext: false, scanNext: false },
    usedField: Object.fromEntries(FIELD_CONFIG.map((field) => [field.key, false])),
    rematchWanted: false,
  };
}

function drawCards(player, count) {
  const drawn = [];
  for (let i = 0; i < count; i += 1) {
    const nextCard = player.deck.shift();
    if (nextCard) {
      player.hand.push(nextCard);
      drawn.push(nextCard);
    }
  }
  return drawn;
}

function removeCardsById(cards, ids) {
  const selected = [];
  for (const id of ids) {
    const index = cards.findIndex((card) => card.id === id);
    if (index === -1) return null;
    selected.push(cards.splice(index, 1)[0]);
  }
  return selected;
}

function getOpponentId(game, playerId) {
  return game.playerOrder.find((id) => id !== playerId);
}

function calculateFieldTotals(board, fieldKey) {
  return board[fieldKey]
    .filter((card) => !card.deleted)
    .reduce((sum, card) => sum + card.power, 0);
}

function getRoundPrompt(game, playerId) {
  const player = game.players[playerId];
  switch (game.phase) {
    case "transfer":
      return player.pendingTransfer.length === 2
        ? "상대의 카드 전송을 기다리는 중입니다."
        : "손패에서 2장을 선택해 상대에게 전송하세요.";
    case "play_simultaneous":
      return player.pendingPlay.length === game.playQuota[playerId]
        ? "상대의 출격 선택을 기다리는 중입니다."
        : `${game.playQuota[playerId]}장을 출격하세요.`;
    case "play_sequential_first":
      return game.firstSelectorId === playerId
        ? `디지스캔 대응 중: 먼저 ${game.playQuota[playerId]}장을 출격하세요.`
        : "상대가 먼저 출격을 선택하는 중입니다.";
    case "play_sequential_second":
      return game.secondSelectorId === playerId
        ? `디지스캔 활성화: 상대 공개 후 ${game.playQuota[playerId]}장을 선택하세요.`
        : "상대가 디지스캔 효과로 대응 중입니다.";
    case "round_summary":
      return "카드 효과 처리 중입니다.";
    case "finished":
      return "최종 결과가 계산되었습니다.";
    default:
      return "배틀 준비 중입니다.";
  }
}

function createGame(room) {
  const masterDeck = shuffle(CARD_POOL);
  const roomPlayers = room.players.slice(0, 2);
  const firstDeck = shuffle(masterDeck.slice(0, 18));
  const secondDeck = shuffle(masterDeck.slice(18, 36));

  const game = {
    round: 0,
    phase: "setup",
    status: "playing",
    playerOrder: [roomPlayers[0].id, roomPlayers[1].id],
    players: {
      [roomPlayers[0].id]: createPlayerGameState(roomPlayers[0], firstDeck),
      [roomPlayers[1].id]: createPlayerGameState(roomPlayers[1], secondDeck),
    },
    playQuota: {
      [roomPlayers[0].id]: 1,
      [roomPlayers[1].id]: 1,
    },
    scanActive: {
      [roomPlayers[0].id]: false,
      [roomPlayers[1].id]: false,
    },
    firstSelectorId: null,
    secondSelectorId: null,
    lastReveal: null,
    lastTransfer: null,
    lastDraw: null,
    result: null,
  };

  for (const playerId of game.playerOrder) drawCards(game.players[playerId], 2);
  startNextRound(game);
  return game;
}

function startNextRound(game) {
  game.lastReveal = null;
  game.lastTransfer = null;
  game.firstSelectorId = null;
  game.secondSelectorId = null;
  if (game.round >= 8) {
    finalizeGame(game);
    return;
  }
  game.round += 1;
  game.phase = "transfer";
  const drawnByPlayer = {};

  for (const playerId of game.playerOrder) {
    const player = game.players[playerId];
    player.pendingTransfer = [];
    player.pendingPlay = [];
    drawnByPlayer[playerId] = drawCards(player, 2).map((card) => ({ ...card }));
  }

  game.lastDraw = { byPlayer: drawnByPlayer, round: game.round };
}

function enterPlayPhase(game) {
  for (const playerId of game.playerOrder) {
    const player = game.players[playerId];
    game.playQuota[playerId] = player.flags.doubleNext ? 2 : 1;
    game.scanActive[playerId] = !!player.flags.scanNext;
    player.flags.doubleNext = false;
    player.flags.scanNext = false;
    player.pendingPlay = [];
  }

  const [firstPlayerId, secondPlayerId] = game.playerOrder;
  const firstScan = game.scanActive[firstPlayerId];
  const secondScan = game.scanActive[secondPlayerId];

  if (firstScan && !secondScan) {
    game.phase = "play_sequential_first";
    game.firstSelectorId = secondPlayerId;
    game.secondSelectorId = firstPlayerId;
  } else if (!firstScan && secondScan) {
    game.phase = "play_sequential_first";
    game.firstSelectorId = firstPlayerId;
    game.secondSelectorId = secondPlayerId;
  } else {
    game.phase = "play_simultaneous";
  }
}

function processTransfers(game) {
  const [firstId, secondId] = game.playerOrder;
  const firstPlayer = game.players[firstId];
  const secondPlayer = game.players[secondId];

  const firstSent = firstPlayer.pendingTransfer.map((card) => ({ ...card }));
  const secondSent = secondPlayer.pendingTransfer.map((card) => ({ ...card }));

  secondPlayer.hand.push(...firstPlayer.pendingTransfer);
  firstPlayer.hand.push(...secondPlayer.pendingTransfer);

  game.lastTransfer = {
    byPlayer: {
      [firstId]: firstSent,
      [secondId]: secondSent,
    },
  };

  firstPlayer.pendingTransfer = [];
  secondPlayer.pendingTransfer = [];
  firstPlayer.hand.sort(sortCards);
  secondPlayer.hand.sort(sortCards);

  enterPlayPhase(game);
}

function resolveRound(game) {
  const plays = {};
  const allPlayed = [];

  for (const playerId of game.playerOrder) {
    const player = game.players[playerId];
    plays[playerId] = player.pendingPlay.map((card) => ({
      ...card,
      deleted: false,
      ownerId: playerId,
      round: game.round,
    }));
    allPlayed.push(...plays[playerId]);
  }

  const hasFileCrash = allPlayed.some((card) => card.effectKey === "file_crash");
  if (hasFileCrash) {
    for (const card of allPlayed) {
      if (card.power >= 7) card.deleted = true;
    }
  }

  for (const playerId of game.playerOrder) {
    const player = game.players[playerId];
    for (const card of plays[playerId]) {
      player.usedField[card.fieldKey] = true;
      player.board[card.fieldKey].push({ ...card });
      if (card.effectKey === "double_digivolve" && game.round < 8) player.flags.doubleNext = true;
      if (card.effectKey === "digiscan" && game.round < 8) player.flags.scanNext = true;
    }
    player.pendingPlay = [];
  }

  game.lastReveal = {
    byPlayer: Object.fromEntries(game.playerOrder.map((playerId) => [playerId, plays[playerId]])),
    hadFileCrash: hasFileCrash,
  };

  if (game.round >= 8) finalizeGame(game);
  else game.phase = "round_summary";
}

function finalizeGame(game) {
  const [firstId, secondId] = game.playerOrder;
  const firstPlayer = game.players[firstId];
  const secondPlayer = game.players[secondId];

  const totals = { [firstId]: 0, [secondId]: 0 };
  const fieldBreakdown = [];

  for (const field of FIELD_CONFIG) {
    const firstTotal = calculateFieldTotals(firstPlayer.board, field.key);
    const secondTotal = calculateFieldTotals(secondPlayer.board, field.key);
    const firstRemaining = firstPlayer.hand.filter((card) => card.fieldKey === field.key);
    const secondRemaining = secondPlayer.hand.filter((card) => card.fieldKey === field.key);

    let firstScore = 0;
    let secondScore = 0;
    let control = "tie";

    if (firstTotal > secondTotal) control = firstId;
    else if (secondTotal > firstTotal) control = secondId;

    if (firstPlayer.usedField[field.key]) {
      firstScore = control === firstId
        ? firstRemaining.reduce((sum, card) => sum + card.power, 0)
        : (firstRemaining.length ? Math.min(...firstRemaining.map((card) => card.power)) : 0);
    }
    if (secondPlayer.usedField[field.key]) {
      secondScore = control === secondId
        ? secondRemaining.reduce((sum, card) => sum + card.power, 0)
        : (secondRemaining.length ? Math.min(...secondRemaining.map((card) => card.power)) : 0);
    }

    totals[firstId] += firstScore;
    totals[secondId] += secondScore;

    fieldBreakdown.push({
      fieldKey: field.key,
      fieldName: field.name,
      firstPlayerTotal: firstTotal,
      secondPlayerTotal: secondTotal,
      firstScore,
      secondScore,
      control,
      firstUsed: firstPlayer.usedField[field.key],
      secondUsed: secondPlayer.usedField[field.key],
    });
  }

  let winner = "draw";
  if (totals[firstId] > totals[secondId]) winner = firstId;
  if (totals[secondId] > totals[firstId]) winner = secondId;

  game.phase = "finished";
  game.status = "finished";
  game.result = { totals, winner, fieldBreakdown, order: [...game.playerOrder] };
}

function submitTransfer(game, playerId, cardIds) {
  if (game.phase !== "transfer") return { ok: false, message: "지금은 카드 전송 단계가 아닙니다." };
  if (!Array.isArray(cardIds) || cardIds.length !== 2 || new Set(cardIds).size !== 2) {
    return { ok: false, message: "전송 카드는 정확히 2장이어야 합니다." };
  }

  const player = game.players[playerId];
  if (!player) return { ok: false, message: "플레이어를 찾을 수 없습니다." };
  if (player.pendingTransfer.length) return { ok: false, message: "이미 전송 카드를 제출했습니다." };

  const removed = removeCardsById(player.hand, cardIds);
  if (!removed) return { ok: false, message: "손패에서 카드를 찾을 수 없습니다." };

  player.pendingTransfer = removed;
  const allReady = game.playerOrder.every((id) => game.players[id].pendingTransfer.length === 2);
  if (allReady) processTransfers(game);
  return { ok: true };
}

function submitPlay(game, playerId, cardIds) {
  if (!["play_simultaneous", "play_sequential_first", "play_sequential_second"].includes(game.phase)) {
    return { ok: false, message: "지금은 출격 단계를 진행할 수 없습니다." };
  }

  const player = game.players[playerId];
  if (!player) return { ok: false, message: "플레이어를 찾을 수 없습니다." };

  const requiredCount = game.playQuota[playerId];
  if (!Array.isArray(cardIds) || cardIds.length !== requiredCount || new Set(cardIds).size !== requiredCount) {
    return { ok: false, message: `출격 카드는 정확히 ${requiredCount}장이어야 합니다.` };
  }

  if (player.pendingPlay.length) return { ok: false, message: "이미 출격 카드를 제출했습니다." };
  if (game.phase === "play_sequential_first" && game.firstSelectorId !== playerId) {
    return { ok: false, message: "상대가 먼저 선택해야 합니다." };
  }
  if (game.phase === "play_sequential_second" && game.secondSelectorId !== playerId) {
    return { ok: false, message: "지금은 상대가 선택 중입니다." };
  }

  const removed = removeCardsById(player.hand, cardIds);
  if (!removed) return { ok: false, message: "출격 카드가 손패에 없습니다." };
  player.pendingPlay = removed;

  if (game.phase === "play_simultaneous") {
    const allReady = game.playerOrder.every((id) => game.players[id].pendingPlay.length === game.playQuota[id]);
    if (allReady) resolveRound(game);
    return { ok: true };
  }

  if (game.phase === "play_sequential_first") {
    game.phase = "play_sequential_second";
    return { ok: true };
  }

  if (game.phase === "play_sequential_second") {
    resolveRound(game);
    return { ok: true };
  }

  return { ok: true };
}

function buildRoomSummary(room) {
  return {
    code: room.code,
    name: room.name,
    isPrivate: room.isPrivate,
    status: room.status,
    createdAt: room.createdAt,
    playerCount: room.players.length,
    players: room.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      ready: player.ready,
      connected: player.connected,
      isHost: room.hostId === player.id,
    })),
  };
}

function buildLobbyState(room, playerId) {
  return {
    code: room.code,
    name: room.name,
    isPrivate: room.isPrivate,
    status: room.status,
    hostId: room.hostId,
    me: playerId,
    canStart: room.players.length === 2 && room.players.every((player) => player.ready) && room.hostId === playerId,
    players: room.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      ready: player.ready,
      connected: player.connected,
      isHost: room.hostId === player.id,
    })),
  };
}

function buildGameView(room, playerId) {
  const game = room.game;
  const opponentId = getOpponentId(game, playerId);
  const me = game.players[playerId];
  const opponent = game.players[opponentId];

  const fields = FIELD_CONFIG.map((field) => ({
    key: field.key,
    name: field.name,
    short: field.short,
    color: field.color,
    myTotal: calculateFieldTotals(me.board, field.key),
    oppTotal: calculateFieldTotals(opponent.board, field.key),
    myPlayedCount: me.board[field.key].length,
    oppPlayedCount: opponent.board[field.key].length,
    myUsed: me.usedField[field.key],
    oppUsed: opponent.usedField[field.key],
    myCards: me.board[field.key].map((card) => ({ ...card })),
    oppCards: opponent.board[field.key].map((card) => ({ ...card })),
  }));

  let actionType = null;
  let canAct = false;
  let requiredCount = 0;
  let peekCards = [];
  let lockedCards = me.pendingPlay.map((card) => ({ ...card }));

  if (game.phase === "transfer") {
    actionType = "transfer";
    canAct = me.pendingTransfer.length === 0;
    requiredCount = 2;
    lockedCards = me.pendingTransfer.map((card) => ({ ...card }));
  } else if (game.phase === "play_simultaneous") {
    actionType = "play";
    canAct = me.pendingPlay.length === 0;
    requiredCount = game.playQuota[playerId];
  } else if (game.phase === "play_sequential_first") {
    actionType = "play";
    canAct = game.firstSelectorId === playerId && me.pendingPlay.length === 0;
    requiredCount = game.playQuota[playerId];
  } else if (game.phase === "play_sequential_second") {
    actionType = "play";
    canAct = game.secondSelectorId === playerId && me.pendingPlay.length === 0;
    requiredCount = game.playQuota[playerId];
    if (game.firstSelectorId && game.players[game.firstSelectorId].pendingPlay.length) {
      peekCards = game.players[game.firstSelectorId].pendingPlay.map((card) => ({ ...card }));
    }
  }

  return {
    mode: "online",
    code: room.code,
    name: room.name,
    round: game.round,
    phase: game.phase,
    status: game.status,
    prompt: getRoundPrompt(game, playerId),
    you: {
      id: me.id,
      nickname: me.nickname,
      deckCount: me.deck.length,
      handCount: me.hand.length,
      hand: me.hand.slice().sort(sortCards),
      canPlayCount: game.playQuota[playerId],
      scanActive: game.scanActive[playerId],
      doubleActive: game.playQuota[playerId] === 2,
    },
    opponent: {
      id: opponent.id,
      nickname: opponent.nickname,
      deckCount: opponent.deck.length,
      handCount: opponent.hand.length,
      canPlayCount: game.playQuota[opponentId],
      scanActive: game.scanActive[opponentId],
      connected: room.players.some((player) => player.id === opponentId),
    },
    fields,
    actionType,
    canAct,
    requiredCount,
    peekCards,
    lockedCards,
    lastReveal: game.lastReveal,
    lastTransfer: game.lastTransfer,
    lastDraw: game.lastDraw,
    result: game.result ? { ...game.result, order: [...game.playerOrder] } : null,
    rematch: {
      requestedByYou: me.rematchWanted,
      requestedByOpponent: opponent.rematchWanted,
    },
  };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
    credentials: false,
  },
  transports: ["websocket", "polling"],
});

app.use(express.json());

const PORT = process.env.PORT || 3000;
const rooms = {};
const socketToRoom = {};
const roundTimers = {};

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}
function uniqueRoomCode() {
  let code = randomCode();
  while (rooms[code]) code = randomCode();
  return code;
}
function getRoomBySocketId(socketId) {
  const code = socketToRoom[socketId];
  return code ? rooms[code] : null;
}
function clearRoomTimer(roomCode) {
  if (roundTimers[roomCode]) {
    clearTimeout(roundTimers[roomCode]);
    delete roundTimers[roomCode];
  }
}
function broadcastRoomList() {
  const roomList = Object.values(rooms)
    .filter((room) => !room.isPrivate && room.status === "lobby" && room.players.length > 0 && room.players.length < 2)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((room) => buildRoomSummary(room));
  io.emit("room_list", roomList);
}
function emitRoomUpdate(room) {
  for (const player of room.players) io.to(player.id).emit("room_update", buildLobbyState(room, player.id));
}
function emitGameState(room) {
  if (!room.game) return;
  for (const player of room.players) io.to(player.id).emit("game_state", buildGameView(room, player.id));
}
function resetRoomToLobby(room, notice) {
  clearRoomTimer(room.code);
  room.status = "lobby";
  room.players.forEach((player) => { player.ready = false; });
  room.game = null;
  emitRoomUpdate(room);
  if (notice) room.players.forEach((player) => io.to(player.id).emit("error_message", notice));
  broadcastRoomList();
}
function destroyRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  clearRoomTimer(roomCode);
  room.players.forEach((player) => {
    delete socketToRoom[player.id];
    io.sockets.sockets.get(player.id)?.leave(roomCode);
  });
  delete rooms[roomCode];
  broadcastRoomList();
}
function scheduleNextRound(room) {
  clearRoomTimer(room.code);
  roundTimers[room.code] = setTimeout(() => {
    if (!rooms[room.code] || rooms[room.code].game !== room.game) return;
    startNextRound(room.game);
    emitGameState(room);
  }, 2200);
}
function startRoomGame(room) {
  clearRoomTimer(room.code);
  room.players.forEach((player) => { player.ready = false; });
  room.status = "playing";
  room.game = createGame(room);
  room.players.forEach((player) => {
    if (room.game.players[player.id]) room.game.players[player.id].rematchWanted = false;
  });
  emitGameState(room);
  broadcastRoomList();
}
function createRoom(socket, payload) {
  const nickname = String(payload.nickname || "").trim().slice(0, 16) || "테이머";
  const roomName = String(payload.roomName || "").trim().slice(0, 22) || "새 디지털 룸";
  const isPrivate = !!payload.isPrivate;

  const currentRoom = getRoomBySocketId(socket.id);
  if (currentRoom) leaveRoom(socket, false);

  const code = uniqueRoomCode();
  const room = {
    code,
    name: roomName,
    isPrivate,
    hostId: socket.id,
    createdAt: Date.now(),
    status: "lobby",
    players: [{ id: socket.id, nickname, ready: false, connected: true }],
    game: null,
  };
  rooms[code] = room;
  socketToRoom[socket.id] = code;
  socket.join(code);
  emitRoomUpdate(room);
  broadcastRoomList();
}
function joinRoom(socket, payload) {
  const roomCode = String(payload.roomCode || "").trim().toUpperCase();
  const nickname = String(payload.nickname || "").trim().slice(0, 16) || "테이머";
  const room = rooms[roomCode];
  if (!room) return socket.emit("error_message", "해당 방을 찾을 수 없습니다.");
  if (room.players.length >= 2) return socket.emit("error_message", "이미 가득 찬 방입니다.");
  if (room.status !== "lobby") return socket.emit("error_message", "이미 게임이 진행 중인 방입니다.");

  const currentRoom = getRoomBySocketId(socket.id);
  if (currentRoom) leaveRoom(socket, false);

  room.players.push({ id: socket.id, nickname, ready: false, connected: true });
  socketToRoom[socket.id] = room.code;
  socket.join(room.code);
  emitRoomUpdate(room);
  broadcastRoomList();
}
function leaveRoom(socket, emitNotice = true) {
  const room = getRoomBySocketId(socket.id);
  if (!room) return;

  const leavingPlayer = room.players.find((player) => player.id === socket.id);
  room.players = room.players.filter((player) => player.id !== socket.id);
  delete socketToRoom[socket.id];
  socket.leave(room.code);

  if (room.game && room.status !== "lobby" && room.players.length > 0) {
    const survivor = room.players[0];
    io.to(survivor.id).emit("opponent_disconnected", {
      message: `${leavingPlayer?.nickname || "상대"}의 연결이 종료되었습니다.`,
    });
    resetRoomToLobby(room, emitNotice ? "상대의 연결이 종료되어 로비로 돌아갑니다." : "");
    room.hostId = survivor.id;
    emitRoomUpdate(room);
    return;
  }
  if (room.players.length === 0) {
    destroyRoom(room.code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players[0].id;
  room.players.forEach((player) => { player.ready = false; });
  emitRoomUpdate(room);
  broadcastRoomList();
}
function toggleReady(socket) {
  const room = getRoomBySocketId(socket.id);
  if (!room || room.status !== "lobby") return;
  const player = room.players.find((entry) => entry.id === socket.id);
  if (!player) return;
  player.ready = !player.ready;
  emitRoomUpdate(room);
}
function startGameRequest(socket) {
  const room = getRoomBySocketId(socket.id);
  if (!room) return;
  if (room.hostId !== socket.id) return socket.emit("error_message", "방장만 게임을 시작할 수 있습니다.");
  if (room.players.length !== 2) return socket.emit("error_message", "2명이 모여야 시작할 수 있습니다.");
  if (!room.players.every((player) => player.ready)) return socket.emit("error_message", "두 플레이어 모두 준비해야 합니다.");
  startRoomGame(room);
}
function requestRematch(socket) {
  const room = getRoomBySocketId(socket.id);
  if (!room || !room.game || room.game.phase !== "finished") return;
  const playerState = room.game.players[socket.id];
  if (!playerState) return;
  playerState.rematchWanted = true;
  const everyoneReady = room.game.playerOrder.every((playerId) => room.game.players[playerId].rematchWanted);
  if (everyoneReady) startRoomGame(room);
  else emitGameState(room);
}

io.on("connection", (socket) => {
  socket.emit("room_list", Object.values(rooms)
    .filter((room) => !room.isPrivate && room.status === "lobby" && room.players.length > 0 && room.players.length < 2)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((room) => buildRoomSummary(room)));

  socket.on("request_room_list", () => {
    socket.emit("room_list", Object.values(rooms)
      .filter((room) => !room.isPrivate && room.status === "lobby" && room.players.length > 0 && room.players.length < 2)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((room) => buildRoomSummary(room)));
  });
  socket.on("create_room", (payload = {}) => createRoom(socket, payload));
  socket.on("join_room", (payload = {}) => joinRoom(socket, payload));
  socket.on("leave_room", () => leaveRoom(socket, false));
  socket.on("toggle_ready", () => toggleReady(socket));
  socket.on("start_game", () => startGameRequest(socket));

  socket.on("submit_transfer", (payload = {}) => {
    const room = getRoomBySocketId(socket.id);
    if (!room || !room.game) return;
    const result = submitTransfer(room.game, socket.id, payload.cardIds || []);
    if (!result.ok) return socket.emit("error_message", result.message);
    emitGameState(room);
  });

  socket.on("submit_play", (payload = {}) => {
    const room = getRoomBySocketId(socket.id);
    if (!room || !room.game) return;
    const result = submitPlay(room.game, socket.id, payload.cardIds || []);
    if (!result.ok) return socket.emit("error_message", result.message);
    emitGameState(room);
    if (room.game.phase === "round_summary") scheduleNextRound(room);
  });

  socket.on("rematch_request", () => requestRematch(socket));
  socket.on("rematch_accept", () => requestRematch(socket));
  socket.on("disconnect", () => leaveRoom(socket, true));
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "jani-penguin-digimon-server",
    rooms: Object.keys(rooms).length,
    uptime: process.uptime(),
  });
});

app.get("/rooms", (req, res) => {
  res.json(Object.values(rooms).filter((room) => !room.isPrivate).map((room) => buildRoomSummary(room)));
});

server.listen(PORT, () => {
  console.log(`Digital battle server listening on ${PORT}`);
});
