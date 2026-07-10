(() => {
  "use strict";

  const COLS = 10;
  const ROWS = 20;
  const LOCK_DELAY = 460;
  const STORAGE_KEYS = {
    best: "neon-blocks-best-score",
    sound: "neon-blocks-sound",
  };

  const COLORS = {
    I: "#22e5ff",
    J: "#4e72ff",
    L: "#ff9f43",
    O: "#ffd84d",
    S: "#61ef9e",
    T: "#a66cff",
    Z: "#ff4f79",
  };

  const SHAPES = {
    I: [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    J: [
      [1, 0, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
    L: [
      [0, 0, 1],
      [1, 1, 1],
      [0, 0, 0],
    ],
    O: [
      [1, 1],
      [1, 1],
    ],
    S: [
      [0, 1, 1],
      [1, 1, 0],
      [0, 0, 0],
    ],
    T: [
      [0, 1, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
    Z: [
      [1, 1, 0],
      [0, 1, 1],
      [0, 0, 0],
    ],
  };

  const boardCanvas = document.querySelector("#boardCanvas");
  const holdCanvas = document.querySelector("#holdCanvas");
  const nextCanvas = document.querySelector("#nextCanvas");
  const boardFrame = document.querySelector("#boardFrame");
  const overlay = document.querySelector("#gameOverlay");
  const overlayEyebrow = document.querySelector("#overlayEyebrow");
  const overlayTitle = document.querySelector("#overlayTitle");
  const overlayMessage = document.querySelector("#overlayMessage");
  const overlayHint = document.querySelector("#overlayHint");
  const startButton = document.querySelector("#startButton");
  const pauseButton = document.querySelector("#pauseButton");
  const newGameButton = document.querySelector("#newGameButton");
  const soundButton = document.querySelector("#soundButton");
  const holdHint = document.querySelector("#holdHint");
  const lineToast = document.querySelector("#lineToast");
  const statusText = document.querySelector("#statusText");
  const statusLight = document.querySelector(".status-light");
  const scoreValue = document.querySelector("#scoreValue");
  const bestValue = document.querySelector("#bestValue");
  const levelValue = document.querySelector("#levelValue");
  const linesValue = document.querySelector("#linesValue");
  const comboValue = document.querySelector("#comboValue");

  let board = emptyBoard();
  let bag = [];
  let queue = [];
  let current = null;
  let heldType = null;
  let holdUsed = false;
  let score = 0;
  let best = readNumber(STORAGE_KEYS.best);
  let lines = 0;
  let level = 1;
  let combo = -1;
  let backToBack = false;
  let gameState = "ready";
  let lastTime = 0;
  let fallAccumulator = 0;
  let lockStartedAt = 0;
  let softDropHeld = false;
  let clearFlash = { rows: [], until: 0 };
  let toastTimer = 0;

  class SoundFX {
    constructor() {
      this.context = null;
      this.enabled = readBoolean(STORAGE_KEYS.sound, true);
    }

    ensureContext() {
      if (!this.enabled) return null;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return null;
      if (!this.context) this.context = new AudioContext();
      if (this.context.state === "suspended") this.context.resume();
      return this.context;
    }

    tone(frequency, duration = 0.05, volume = 0.025, type = "square", delay = 0) {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + delay;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(volume, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
    }

    move() { this.tone(170, 0.025, 0.012); }
    rotate() { this.tone(330, 0.045, 0.018); }
    lock() { this.tone(105, 0.07, 0.025, "triangle"); }
    hold() { this.tone(240, 0.04, 0.018); this.tone(360, 0.05, 0.014, "square", 0.035); }
    clear(count) {
      [330, 440, 550, 700].slice(0, Math.max(2, count)).forEach((tone, index) => {
        this.tone(tone, 0.13, 0.026, "square", index * 0.045);
      });
    }
    over() {
      [260, 210, 160, 105].forEach((tone, index) => this.tone(tone, 0.18, 0.024, "sawtooth", index * 0.11));
    }
  }

  const sound = new SoundFX();

  function emptyBoard() {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  function readNumber(key) {
    try {
      const value = Number.parseInt(localStorage.getItem(key) || "0", 10);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  function readBoolean(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value === "true";
    } catch {
      return fallback;
    }
  }

  function store(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* Storage can be unavailable in privacy mode. */ }
  }

  function shuffle(values) {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.random() * (index + 1));
      [values[index], values[target]] = [values[target], values[index]];
    }
    return values;
  }

  function pullFromBag() {
    if (!bag.length) bag = shuffle(Object.keys(SHAPES));
    return bag.pop();
  }

  function ensureQueue() {
    while (queue.length < 6) queue.push(pullFromBag());
  }

  function cloneMatrix(matrix) {
    return matrix.map((row) => [...row]);
  }

  function createPiece(type) {
    const matrix = cloneMatrix(SHAPES[type]);
    return {
      type,
      matrix,
      x: Math.floor((COLS - matrix[0].length) / 2),
      y: type === "I" ? -1 : -2,
    };
  }

  function spawnPiece(forcedType = null) {
    ensureQueue();
    const type = forcedType || queue.shift();
    ensureQueue();
    current = createPiece(type);
    lockStartedAt = 0;
    fallAccumulator = 0;
    if (collides(current, 0, 0, current.matrix)) endGame();
    drawSideCanvases();
  }

  function collides(piece, offsetX, offsetY, matrix) {
    for (let row = 0; row < matrix.length; row += 1) {
      for (let col = 0; col < matrix[row].length; col += 1) {
        if (!matrix[row][col]) continue;
        const x = piece.x + col + offsetX;
        const y = piece.y + row + offsetY;
        if (x < 0 || x >= COLS || y >= ROWS) return true;
        if (y >= 0 && board[y][x]) return true;
      }
    }
    return false;
  }

  function rotateMatrix(matrix, clockwise) {
    const size = matrix.length;
    const rotated = Array.from({ length: size }, () => Array(size).fill(0));
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (clockwise) rotated[col][size - 1 - row] = matrix[row][col];
        else rotated[size - 1 - col][row] = matrix[row][col];
      }
    }
    return rotated;
  }

  function moveHorizontal(direction) {
    if (gameState !== "playing" || !current) return;
    if (!collides(current, direction, 0, current.matrix)) {
      current.x += direction;
      resetLockDelay();
      sound.move();
    }
  }

  function rotatePiece(clockwise = true) {
    if (gameState !== "playing" || !current || current.type === "O") return;
    const rotated = rotateMatrix(current.matrix, clockwise);
    const kicks = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1]];
    for (const [x, y] of kicks) {
      if (!collides(current, x, y, rotated)) {
        current.matrix = rotated;
        current.x += x;
        current.y += y;
        resetLockDelay();
        sound.rotate();
        return;
      }
    }
  }

  function stepDown(manual = false) {
    if (gameState !== "playing" || !current) return false;
    if (!collides(current, 0, 1, current.matrix)) {
      current.y += 1;
      lockStartedAt = 0;
      if (manual) {
        score += 1;
        syncStats();
      }
      return true;
    }
    if (!lockStartedAt) lockStartedAt = performance.now();
    return false;
  }

  function hardDrop() {
    if (gameState !== "playing" || !current) return;
    let distance = 0;
    while (!collides(current, 0, 1, current.matrix)) {
      current.y += 1;
      distance += 1;
    }
    score += distance * 2;
    boardFrame.classList.remove("is-shaking");
    void boardFrame.offsetWidth;
    boardFrame.classList.add("is-shaking");
    lockPiece();
  }

  function resetLockDelay() {
    if (current && collides(current, 0, 1, current.matrix)) lockStartedAt = performance.now();
    else lockStartedAt = 0;
  }

  function mergePiece() {
    let aboveTop = false;
    current.matrix.forEach((row, rowIndex) => {
      row.forEach((filled, colIndex) => {
        if (!filled) return;
        const x = current.x + colIndex;
        const y = current.y + rowIndex;
        if (y < 0) aboveTop = true;
        else board[y][x] = current.type;
      });
    });
    return aboveTop;
  }

  function lockPiece() {
    if (!current || gameState !== "playing") return;
    const aboveTop = mergePiece();
    sound.lock();
    if (aboveTop) {
      endGame();
      return;
    }
    const cleared = clearLines();
    awardClear(cleared.count);
    if (cleared.count) {
      clearFlash = { rows: cleared.rows, until: performance.now() + 170 };
      sound.clear(cleared.count);
    }
    holdUsed = false;
    spawnPiece();
    syncStats();
  }

  function clearLines() {
    const removedRows = [];
    for (let row = ROWS - 1; row >= 0; row -= 1) {
      if (board[row].every(Boolean)) {
        removedRows.push(row);
        board.splice(row, 1);
        board.unshift(Array(COLS).fill(null));
        row += 1;
      }
    }
    return { count: removedRows.length, rows: removedRows };
  }

  function awardClear(count) {
    if (!count) {
      combo = -1;
      return;
    }
    combo += 1;
    const base = [0, 100, 300, 500, 800][count] * level;
    const b2bBonus = count === 4 && backToBack ? Math.floor(base * 0.5) : 0;
    const comboBonus = combo > 0 ? combo * 50 * level : 0;
    score += base + b2bBonus + comboBonus;
    lines += count;
    level = Math.floor(lines / 10) + 1;
    if (count === 4) backToBack = true;
    else backToBack = false;

    const names = ["", "SINGLE", "DOUBLE", "TRIPLE", "TETRIS!"];
    showToast(names[count] + (combo > 0 ? `  ×${combo + 1}` : ""));
  }

  function holdPiece() {
    if (gameState !== "playing" || !current || holdUsed) return;
    const outgoing = current.type;
    if (heldType) {
      const incoming = heldType;
      heldType = outgoing;
      current = createPiece(incoming);
      if (collides(current, 0, 0, current.matrix)) {
        endGame();
        return;
      }
    } else {
      heldType = outgoing;
      spawnPiece();
    }
    holdUsed = true;
    lockStartedAt = 0;
    holdHint.classList.add("is-hidden");
    sound.hold();
    drawSideCanvases();
  }

  function dropInterval() {
    return Math.max(75, 920 * Math.pow(0.82, level - 1));
  }

  function startGame() {
    board = emptyBoard();
    bag = [];
    queue = [];
    current = null;
    heldType = null;
    holdUsed = false;
    score = 0;
    lines = 0;
    level = 1;
    combo = -1;
    backToBack = false;
    clearFlash = { rows: [], until: 0 };
    gameState = "playing";
    softDropHeld = false;
    overlay.classList.remove("is-visible");
    holdHint.classList.remove("is-hidden");
    setStatus("游戏进行中", true);
    updatePauseButton();
    spawnPiece();
    syncStats();
    boardCanvas.focus({ preventScroll: true });
    sound.ensureContext();
    sound.tone(440, 0.07, 0.02);
    sound.tone(660, 0.08, 0.018, "square", 0.06);
  }

  function togglePause(forcePause = false) {
    if (gameState === "ready" || gameState === "over") return;
    if (gameState === "playing" || forcePause) {
      if (gameState !== "playing") return;
      gameState = "paused";
      softDropHeld = false;
      showOverlay("PAUSED", "游戏已暂停，休息一下再继续。", "继续游戏", "按 P 或 ESC 继续");
      setStatus("已暂停", false);
    } else {
      gameState = "playing";
      overlay.classList.remove("is-visible");
      setStatus("游戏进行中", true);
      lastTime = performance.now();
      boardCanvas.focus({ preventScroll: true });
    }
    updatePauseButton();
  }

  function endGame() {
    gameState = "over";
    current = null;
    softDropHeld = false;
    if (score > best) {
      best = score;
      store(STORAGE_KEYS.best, best);
    }
    syncStats();
    showOverlay("GAME<br>OVER", `本局得分 ${score.toLocaleString("zh-CN")}，消除了 ${lines} 行。`, "再来一局", "按 Enter 或 R 重新开始");
    setStatus("游戏结束", false);
    updatePauseButton();
    sound.over();
  }

  function showOverlay(title, message, buttonLabel, hint) {
    overlayEyebrow.textContent = title.startsWith("PAUSED") ? "BREAK TIME" : "RUN ENDED";
    overlayTitle.innerHTML = title;
    overlayMessage.textContent = message;
    startButton.firstChild.textContent = `${buttonLabel} `;
    overlayHint.textContent = hint;
    overlay.classList.add("is-visible");
  }

  function setStatus(text, live) {
    statusText.textContent = text;
    statusLight.classList.toggle("is-live", live);
  }

  function updatePauseButton() {
    const paused = gameState === "paused";
    pauseButton.querySelector(".pause-glyph").textContent = paused ? "▶" : "Ⅱ";
    pauseButton.querySelector(".pause-label").textContent = paused ? "继续" : "暂停";
  }

  function syncStats() {
    if (score > best) best = score;
    scoreValue.textContent = String(score).padStart(6, "0");
    bestValue.textContent = String(best).padStart(6, "0");
    levelValue.textContent = String(level).padStart(2, "0");
    linesValue.textContent = String(lines).padStart(2, "0");
    comboValue.textContent = combo > 0 ? `×${combo + 1}` : "—";
  }

  function showToast(text) {
    clearTimeout(toastTimer);
    lineToast.textContent = text;
    lineToast.classList.remove("is-visible");
    void lineToast.offsetWidth;
    lineToast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => lineToast.classList.remove("is-visible"), 650);
  }

  function canvasContext(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const targetWidth = Math.round(width * dpr);
    const targetHeight = Math.round(height * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { context, width, height };
  }

  function colorWithAlpha(hex, alpha) {
    const value = Number.parseInt(hex.slice(1), 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }

  function drawBlock(context, x, y, width, height, color, options = {}) {
    const inset = Math.max(1, width * 0.055);
    const px = x + inset;
    const py = y + inset;
    const w = width - inset * 2;
    const h = height - inset * 2;

    if (options.ghost) {
      context.strokeStyle = colorWithAlpha(color, 0.42);
      context.lineWidth = Math.max(1, width * 0.055);
      context.strokeRect(px + 1, py + 1, w - 2, h - 2);
      context.fillStyle = colorWithAlpha(color, 0.055);
      context.fillRect(px + 2, py + 2, w - 4, h - 4);
      return;
    }

    context.save();
    context.shadowColor = colorWithAlpha(color, options.mini ? 0.28 : 0.34);
    context.shadowBlur = options.mini ? 5 : 8;
    context.fillStyle = color;
    context.fillRect(px, py, w, h);
    context.shadowBlur = 0;

    context.fillStyle = "rgba(255,255,255,.30)";
    context.beginPath();
    context.moveTo(px, py);
    context.lineTo(px + w, py);
    context.lineTo(px + w - inset * 1.5, py + inset * 1.5);
    context.lineTo(px + inset * 1.5, py + inset * 1.5);
    context.closePath();
    context.fill();

    context.fillStyle = "rgba(0,0,0,.24)";
    context.beginPath();
    context.moveTo(px + w, py);
    context.lineTo(px + w, py + h);
    context.lineTo(px + w - inset * 1.5, py + h - inset * 1.5);
    context.lineTo(px + w - inset * 1.5, py + inset * 1.5);
    context.closePath();
    context.fill();

    context.strokeStyle = "rgba(255,255,255,.18)";
    context.lineWidth = 0.75;
    context.strokeRect(px + inset * 1.5, py + inset * 1.5, w - inset * 3, h - inset * 3);
    context.restore();
  }

  function drawBoard(time = performance.now()) {
    const { context, width, height } = canvasContext(boardCanvas);
    const cellWidth = width / COLS;
    const cellHeight = height / ROWS;

    context.clearRect(0, 0, width, height);
    const background = context.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, "#090e15");
    background.addColorStop(1, "#06090e");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);

    context.strokeStyle = "rgba(126,151,180,.075)";
    context.lineWidth = 1;
    context.beginPath();
    for (let col = 1; col < COLS; col += 1) {
      context.moveTo(Math.round(col * cellWidth) + 0.5, 0);
      context.lineTo(Math.round(col * cellWidth) + 0.5, height);
    }
    for (let row = 1; row < ROWS; row += 1) {
      context.moveTo(0, Math.round(row * cellHeight) + 0.5);
      context.lineTo(width, Math.round(row * cellHeight) + 0.5);
    }
    context.stroke();

    board.forEach((row, rowIndex) => {
      row.forEach((type, colIndex) => {
        if (type) drawBlock(context, colIndex * cellWidth, rowIndex * cellHeight, cellWidth, cellHeight, COLORS[type]);
      });
    });

    if (current && gameState !== "over") {
      let ghostY = current.y;
      while (!collides({ ...current, y: ghostY }, 0, 1, current.matrix)) ghostY += 1;
      drawPiece(context, { ...current, y: ghostY }, cellWidth, cellHeight, true);
      drawPiece(context, current, cellWidth, cellHeight, false);
    }

    if (clearFlash.rows.length && time < clearFlash.until) {
      const opacity = Math.max(0, (clearFlash.until - time) / 170);
      context.fillStyle = `rgba(255,255,255,${opacity * 0.65})`;
      clearFlash.rows.forEach((row) => context.fillRect(0, row * cellHeight, width, cellHeight));
    }
  }

  function drawPiece(context, piece, cellWidth, cellHeight, ghost) {
    piece.matrix.forEach((row, rowIndex) => {
      row.forEach((filled, colIndex) => {
        if (!filled) return;
        const x = piece.x + colIndex;
        const y = piece.y + rowIndex;
        if (y >= 0) drawBlock(context, x * cellWidth, y * cellHeight, cellWidth, cellHeight, COLORS[piece.type], { ghost });
      });
    });
  }

  function occupiedBounds(matrix) {
    let minRow = matrix.length;
    let maxRow = -1;
    let minCol = matrix[0].length;
    let maxCol = -1;
    matrix.forEach((row, rowIndex) => row.forEach((filled, colIndex) => {
      if (!filled) return;
      minRow = Math.min(minRow, rowIndex);
      maxRow = Math.max(maxRow, rowIndex);
      minCol = Math.min(minCol, colIndex);
      maxCol = Math.max(maxCol, colIndex);
    }));
    return { minRow, maxRow, minCol, maxCol };
  }

  function drawMiniPiece(context, type, centerX, centerY, maxWidth, maxHeight) {
    const matrix = SHAPES[type];
    const bounds = occupiedBounds(matrix);
    const cols = bounds.maxCol - bounds.minCol + 1;
    const rows = bounds.maxRow - bounds.minRow + 1;
    const size = Math.min(maxWidth / cols, maxHeight / rows, 25);
    const startX = centerX - (cols * size) / 2;
    const startY = centerY - (rows * size) / 2;
    for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
      for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) {
        if (!matrix[row][col]) continue;
        drawBlock(context, startX + (col - bounds.minCol) * size, startY + (row - bounds.minRow) * size, size, size, COLORS[type], { mini: true });
      }
    }
  }

  function drawSideCanvases() {
    const hold = canvasContext(holdCanvas);
    hold.context.clearRect(0, 0, hold.width, hold.height);
    if (heldType) drawMiniPiece(hold.context, heldType, hold.width / 2, hold.height / 2 - 3, hold.width - 36, hold.height - 35);

    const next = canvasContext(nextCanvas);
    next.context.clearRect(0, 0, next.width, next.height);
    const visibleCount = 5;
    const slotHeight = next.height / visibleCount;
    queue.slice(0, visibleCount).forEach((type, index) => {
      if (index > 0) {
        next.context.strokeStyle = "rgba(255,255,255,.055)";
        next.context.beginPath();
        next.context.moveTo(12, index * slotHeight + 0.5);
        next.context.lineTo(next.width - 12, index * slotHeight + 0.5);
        next.context.stroke();
      }
      drawMiniPiece(next.context, type, next.width / 2, index * slotHeight + slotHeight / 2, next.width - 34, slotHeight - 15);
    });
  }

  function performAction(action) {
    if (gameState !== "playing") return;
    if (action === "left") moveHorizontal(-1);
    if (action === "right") moveHorizontal(1);
    if (action === "down") stepDown(true);
    if (action === "rotate") rotatePiece(true);
    if (action === "drop") hardDrop();
    if (action === "hold") holdPiece();
  }

  function handleKeyDown(event) {
    const code = event.code;
    const controlled = ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Space", "KeyZ", "KeyX", "KeyC", "KeyP", "Escape", "KeyR", "Enter"];
    if (controlled.includes(code)) event.preventDefault();

    if ((gameState === "ready" || gameState === "over") && ["Enter", "Space", "KeyR"].includes(code)) {
      if (!event.repeat) startGame();
      return;
    }
    if (["KeyP", "Escape"].includes(code)) {
      if (!event.repeat) togglePause();
      return;
    }
    if (code === "KeyR") {
      if (!event.repeat) startGame();
      return;
    }
    if (gameState !== "playing") return;
    if (code === "ArrowLeft") moveHorizontal(-1);
    if (code === "ArrowRight") moveHorizontal(1);
    if (code === "ArrowDown") { softDropHeld = true; stepDown(true); }
    if ((code === "ArrowUp" || code === "KeyX") && !event.repeat) rotatePiece(true);
    if (code === "KeyZ" && !event.repeat) rotatePiece(false);
    if (code === "Space" && !event.repeat) hardDrop();
    if (code === "KeyC" && !event.repeat) holdPiece();
  }

  function handleKeyUp(event) {
    if (event.code === "ArrowDown") softDropHeld = false;
  }

  function bindTouchControls() {
    document.querySelectorAll("[data-action]").forEach((button) => {
      let repeatDelay = 0;
      let repeatInterval = 0;
      const action = button.dataset.action;
      const repeatable = ["left", "right", "down"].includes(action);

      const stop = () => {
        clearTimeout(repeatDelay);
        clearInterval(repeatInterval);
        repeatDelay = 0;
        repeatInterval = 0;
        button.classList.remove("is-pressed");
        if (action === "down") softDropHeld = false;
      };

      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        button.setPointerCapture?.(event.pointerId);
        button.classList.add("is-pressed");
        if (action === "down") softDropHeld = true;
        performAction(action);
        if (repeatable) {
          repeatDelay = window.setTimeout(() => {
            repeatInterval = window.setInterval(() => performAction(action), action === "down" ? 55 : 75);
          }, 190);
        }
      });
      button.addEventListener("pointerup", stop);
      button.addEventListener("pointercancel", stop);
      button.addEventListener("lostpointercapture", stop);
    });
  }

  function updateSoundButton() {
    soundButton.classList.toggle("is-muted", !sound.enabled);
    soundButton.setAttribute("aria-label", sound.enabled ? "关闭音效" : "开启音效");
  }

  function loop(time) {
    const delta = lastTime ? Math.min(time - lastTime, 80) : 0;
    lastTime = time;
    if (gameState === "playing" && current) {
      fallAccumulator += delta;
      const interval = softDropHeld ? 48 : dropInterval();
      if (fallAccumulator >= interval) {
        stepDown(softDropHeld);
        fallAccumulator = 0;
      }
      if (collides(current, 0, 1, current.matrix)) {
        if (!lockStartedAt) lockStartedAt = time;
        if (time - lockStartedAt >= LOCK_DELAY) lockPiece();
      } else {
        lockStartedAt = 0;
      }
    }
    drawBoard(time);
    requestAnimationFrame(loop);
  }

  startButton.addEventListener("click", () => {
    if (gameState === "paused") togglePause();
    else startGame();
  });
  pauseButton.addEventListener("click", () => togglePause());
  newGameButton.addEventListener("click", startGame);
  soundButton.addEventListener("click", () => {
    sound.enabled = !sound.enabled;
    store(STORAGE_KEYS.sound, sound.enabled);
    updateSoundButton();
    if (sound.enabled) sound.tone(520, 0.07, 0.022);
  });
  document.addEventListener("keydown", handleKeyDown, { passive: false });
  document.addEventListener("keyup", handleKeyUp);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && gameState === "playing") togglePause(true);
  });
  window.addEventListener("resize", drawSideCanvases);

  ensureQueue();
  syncStats();
  updateSoundButton();
  drawSideCanvases();
  drawBoard();
  bindTouchControls();
  requestAnimationFrame(loop);
})();
