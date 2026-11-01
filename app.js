(() => {
  "use strict";

  const SAVE_KEY = "mellowoku-web-save-v1";
  const MODE_KEY = "mellowoku-web-mode";
  const REGION_COLORS = [
    "#e9c94d", "#69c5bf", "#d985c8", "#6fb5d8",
    "#9fd58b", "#9277d7", "#e296b6", "#f09a73"
  ];
  const DEFAULT_SETTINGS = {
    themeMode: "SYSTEM",
    colorPalette: "STANDARD",
    lightThemeColors: { buttonColor: null, textColor: null, backgroundColor: null },
    darkThemeColors: { buttonColor: null, textColor: null, backgroundColor: null },
    musicEnabled: true,
    uiSoundsEnabled: true,
    musicVolume: 0.55,
    uiVolume: 0.75,
    economyGraphics: false,
    animationsEnabled: true,
    showConflicts: true,
    playerName: "",
    playerGender: "UNSPECIFIED",
    logClassicLevels: false,
    catBuddies: [
      { id: "light-cat", name: "Плюша", isGray: false, isSleeping: false },
      { id: "gray-cat", name: "Дымок", isGray: true, isSleeping: false }
    ]
  };

  const elements = {
    board: document.querySelector("#board"),
    title: document.querySelector("#level-title"),
    subtitle: document.querySelector("#level-subtitle"),
    count: document.querySelector("#progress-count"),
    rules: document.querySelector("#game-rules"),
    picker: document.querySelector("#cat-picker"),
    actions: document.querySelector("#action-buttons"),
    feedback: document.querySelector("#feedback"),
    saveStatus: document.querySelector("#save-status"),
    importFile: document.querySelector("#import-file"),
    installButton: document.querySelector("#install-button")
  };
  const boardFrame = document.querySelector(".board-frame");
  const gameShell = document.querySelector(".game-shell");
  const gameCompanionsList = document.querySelector("#game-companions-list");
  const gameCompanionsToggle = document.querySelector("#game-companions-toggle");
  const gameCompanionsCount = document.querySelector("#game-companions-count");
  const compactLayout = window.matchMedia("(max-width: 680px)");
  let gameCompanionsExpanded = !compactLayout.matches;
  const screens = {
    home: document.querySelector("#screen-home"),
    settings: document.querySelector("#screen-settings"),
    game: document.querySelector("#screen-game")
  };
  const victoryDialog = document.querySelector("#victory-dialog");
  const catDialog = document.querySelector("#cat-dialog");

  function fitBoard() {
    const edge = Math.floor(Math.min(boardFrame.clientWidth, boardFrame.clientHeight, 720));
    if (edge > 0) elements.board.style.setProperty("--board-edge", `${edge}px`);
  }

  let state = loadSavedState();
  let mode = localStorage.getItem(MODE_KEY) === "meow" ? "meow" : "classic";
  let selectedCell = null;
  let selectedValue = null;
  let undoStack = [];
  let deferredInstallPrompt = null;
  let visibleScreen = "home";
  let catBeingEdited = null;
  let pendingMeowTap = null;
  let pointerGesture = null;
  let suppressBoardClickUntil = 0;
  let systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

  if (!state.active) state.active = makeClassicGame(state.highestUnlockedLevel);
  if (!state.activeMeow) {
    state.activeMeow = makeMeowGame(state.meowHighestUnlockedLevel);
  }
  saveState(false);

  if ("ResizeObserver" in window) {
    new ResizeObserver(fitBoard).observe(boardFrame);
  } else {
    window.addEventListener("resize", fitBoard);
  }
  fitBoard();

  function defaultState() {
    return {
      schemaVersion: 1,
      active: null,
      activeMeow: null,
      completed: [],
      highestUnlockedLevel: 1,
      meowHighestUnlockedLevel: 1,
      settings: structuredClone(DEFAULT_SETTINGS)
    };
  }

  function loadSavedState() {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return defaultState();
    try {
      const parsed = JSON.parse(raw);
      if (!isValidSave(parsed)) throw new Error("Сохранение имеет неверный формат.");
      return {
        ...defaultState(),
        ...parsed,
        settings: {
          ...structuredClone(DEFAULT_SETTINGS),
          ...(parsed.settings || {}),
          catBuddies: Array.isArray(parsed.settings?.catBuddies)
            ? parsed.settings.catBuddies
            : structuredClone(DEFAULT_SETTINGS.catBuddies)
        }
      };
    } catch (error) {
      elements.saveStatus.textContent = "Не удалось прочитать сохранение — восстановите его из файла.";
      elements.saveStatus.title = error instanceof Error ? error.message : String(error);
      return defaultState();
    }
  }

  function saveState(showStatus = true) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
      if (showStatus) elements.saveStatus.textContent = "Прогресс сохранён на устройстве";
    } catch (error) {
      elements.saveStatus.textContent = "Не удалось сохранить прогресс";
      elements.saveStatus.title = error instanceof Error ? error.message : String(error);
    }
  }

  class AudioController {
    constructor() {
      this.unlocked = false;
      this.track = null;
      this.musicPlayers = [];
      this.currentPlayer = null;
      this.purrPlayer = null;
      this.settings = state.settings;
      this.fadeTimer = null;
      this.generation = 0;
      this.pendingPlayers = new Set();
      this.audioContext = null;
      this.gainNodes = new WeakMap();
    }

    updateSettings(settings) {
      this.settings = settings;
      if (this.currentPlayer) {
        this.setVolume(this.currentPlayer, this.settings.musicEnabled
          ? this.settings.musicVolume
          : 0);
      }
      if (this.purrPlayer) {
        this.setVolume(this.purrPlayer.player, this.settings.uiSoundsEnabled
          ? this.settings.uiVolume
          : 0);
      }
      if (!settings.uiSoundsEnabled || settings.uiVolume <= 0) this.stopPurr();
      this.playTrackForScreen();
    }

    async unlock() {
      this.unlocked = true;
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!this.audioContext && AudioContextConstructor) {
        try {
          this.audioContext = new AudioContextConstructor();
        } catch (error) {
          this.reportError(error);
          return;
        }
      }
      if (this.audioContext?.state === "suspended") {
        try {
          await this.audioContext.resume();
        } catch (error) {
          this.reportError(error);
          return;
        }
      }
      await this.playTrackForScreen();
    }

    createPlayer(source) {
      const player = new Audio(source);
      if (this.audioContext) {
        try {
          const mediaSource = this.audioContext.createMediaElementSource(player);
          const gain = this.audioContext.createGain();
          mediaSource.connect(gain);
          gain.connect(this.audioContext.destination);
          this.gainNodes.set(player, gain);
        } catch (error) {
          this.reportError(error);
        }
      }
      return player;
    }

    setVolume(player, volume) {
      const gain = this.gainNodes.get(player);
      if (gain && this.audioContext) {
        gain.gain.setValueAtTime(volume, this.audioContext.currentTime);
      } else {
        player.volume = volume;
      }
    }

    async playTrackForScreen() {
      const generation = ++this.generation;
      this.pendingPlayers.forEach((player) => player.pause());
      this.pendingPlayers.clear();
      const desired = this.settings.musicEnabled && this.settings.musicVolume > 0
        ? (visibleScreen === "game" ? "music_gameplay" : "music_menu")
        : null;
      if (desired === this.track && (!desired || this.currentPlayer)) {
        if (this.currentPlayer) {
          this.setVolume(this.currentPlayer, this.settings.musicVolume);
          if (this.unlocked && this.currentPlayer.paused) {
            this.currentPlayer.play().catch((error) => this.reportError(error));
          }
        }
        return;
      }
      this.track = desired;
      if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
      const previousPlayers = this.musicPlayers.slice();
      const previousVolumes = new Map(previousPlayers.map((player) => [
        player,
        this.gainNodes.get(player)?.gain.value ?? player.volume
      ]));
      if (!desired || !this.unlocked) {
        this.currentPlayer = null;
        if (!previousPlayers.length) return;
        const startedAt = performance.now();
        this.fadeTimer = window.setInterval(() => {
          const progress = Math.min(1, (performance.now() - startedAt) / 550);
          previousPlayers.forEach((player) => {
            this.setVolume(player, previousVolumes.get(player) * (1 - progress));
          });
          if (progress === 1) {
            window.clearInterval(this.fadeTimer);
            this.fadeTimer = null;
            previousPlayers.forEach((player) => player.pause());
            this.musicPlayers = [];
          }
        }, 30);
        return;
      }

      const player = this.createPlayer(`./assets/${desired}.mp3`);
      player.loop = true;
      this.setVolume(player, 0);
      this.pendingPlayers.add(player);
      try {
        await player.play();
      } catch (error) {
        this.pendingPlayers.delete(player);
        if (generation !== this.generation) return;
        this.reportError(error);
        return;
      }
      this.pendingPlayers.delete(player);
      if (generation !== this.generation || desired !== this.track) {
        player.pause();
        return;
      }
      this.currentPlayer = player;
      this.musicPlayers = [...previousPlayers, player];
      const startedAt = performance.now();
      this.fadeTimer = window.setInterval(() => {
        const progress = Math.min(1, (performance.now() - startedAt) / 550);
        this.setVolume(player, this.settings.musicVolume * progress);
        previousPlayers.forEach((previous) => {
          this.setVolume(previous, previousVolumes.get(previous) * (1 - progress));
        });
        if (progress === 1) {
          window.clearInterval(this.fadeTimer);
          this.fadeTimer = null;
          previousPlayers.forEach((previous) => previous.pause());
          this.musicPlayers = [player];
        }
      }, 30);
    }

    playEffect(name) {
      if (!this.unlocked || !this.settings.uiSoundsEnabled || this.settings.uiVolume <= 0) return;
      const player = this.createPlayer(`./assets/${name}.mp3`);
      this.setVolume(player, this.settings.uiVolume);
      player.play().catch((error) => this.reportError(error));
    }

    playPurr(cat) {
      if (!this.unlocked || !this.settings.uiSoundsEnabled || this.settings.uiVolume <= 0) return;
      this.stopPurr();
      const player = this.createPlayer("./assets/cat_purr.mp3");
      player.loop = true;
      this.setVolume(player, this.settings.uiVolume);
      this.purrPlayer = { id: cat.id, player };
      player.play().catch((error) => this.reportError(error));
    }

    stopPurr(catId) {
      if (!this.purrPlayer || (catId && this.purrPlayer.id !== catId)) return;
      this.purrPlayer.player.pause();
      this.purrPlayer.player.currentTime = 0;
      this.purrPlayer = null;
    }

    playMeow(cat) {
      if (cat.isSleeping) return;
      this.stopPurr();
      this.playEffect("cat_meow");
    }

    reportError(error) {
      const message = error instanceof Error ? error.message : String(error);
      elements.saveStatus.textContent = "Не удалось воспроизвести звук";
      elements.saveStatus.title = message;
      console.error("Mellowoku audio playback failed:", error);
    }
  }

  const audio = new AudioController();
  applyTheme();

  function applyTheme() {
    const settings = state.settings;
    const dark = settings.themeMode === "DARK" ||
      (settings.themeMode === "SYSTEM" && systemTheme.matches);
    const colors = settings[dark ? "darkThemeColors" : "lightThemeColors"] || {};
    const palettes = dark
      ? {
          STANDARD: ["#29282d", "#35343a", "#403e45", "#d58fb9", "#f3edf2", "#bbb2ba"],
          SOFT_PASTEL: ["#272333", "#352e43", "#443a54", "#d8a4c4", "#f8eff8", "#c5b7ca"]
        }
      : {
          STANDARD: ["#f3f0eb", "#fffdfa", "#ffffff", "#a94c7c", "#29252b", "#625b64"],
          SOFT_PASTEL: ["#fff7ed", "#fffaf8", "#fff0f3", "#bd668d", "#382c37", "#756773"]
        };
    const [page, surface, raised, accent, text, muted] =
      palettes[settings.colorPalette] || palettes.STANDARD;
    const root = document.documentElement;
    root.style.colorScheme = dark ? "dark" : "light";
    root.style.setProperty("--page", colors.backgroundColor || page);
    root.style.setProperty("--surface", colors.backgroundColor
      ? mixColor(colors.backgroundColor, dark ? "#ffffff" : "#000000", dark ? 0.1 : 0.04)
      : surface);
    root.style.setProperty("--surface-raised", raised);
    root.style.setProperty("--accent", colors.buttonColor || accent);
    root.style.setProperty("--text", colors.textColor || text);
    root.style.setProperty("--muted", muted);
    root.style.setProperty("--border", dark ? "#77727a" : "#aaa1a8");
    root.style.setProperty("--surface-border", dark ? "#55535b" : "#d4cbd0");
    root.style.setProperty("--cell-bg", dark ? "#36353b" : "#fffdfa");
    root.style.setProperty("--bar-bg", dark ? "#232227" : "#e9e3e7");
    root.style.setProperty("--grid-heavy", dark ? "#f0d7b4" : "#61525b");
    document.querySelector('meta[name="theme-color"]').content = page;
  }

  function mixColor(color, other, amount) {
    const first = color.match(/^#([0-9a-f]{6})$/i);
    const second = other.match(/^#([0-9a-f]{6})$/i);
    if (!first || !second) return color;
    const channels = [0, 2, 4].map((offset) => {
      const start = parseInt(first[1].slice(offset, offset + 2), 16);
      const end = parseInt(second[1].slice(offset, offset + 2), 16);
      return Math.round(start * (1 - amount) + end * amount).toString(16).padStart(2, "0");
    });
    return `#${channels.join("")}`;
  }

  function showScreen(name) {
    visibleScreen = name;
    Object.entries(screens).forEach(([screen, element]) => {
      element.hidden = screen !== name;
    });
    document.querySelector("#back-home-button").hidden = name !== "game";
    if (name === "game") {
      fitBoard();
      render();
    } else {
      renderHome();
      if (name === "settings") renderSettings();
    }
    audio.playTrackForScreen();
  }

  function startGame(nextMode, newLevel = false) {
    const current = nextMode === "classic" ? state.active : state.activeMeow;
    const solved = current && (nextMode === "classic"
      ? isClassicSolved(current)
      : isMeowSolved(current));
    const hasProgress = current && (nextMode === "classic"
    ? current.board.some((value, index) => !current.level.puzzle[index] && value)
    : current.board.some((value, index) =>
      !current.puzzle.givens[index] && (value || current.xMarks[index])
    ));
    if (newLevel && current && hasProgress && !solved &&
      !window.confirm("Начать новую игру? Текущий незавершённый уровень будет заменён.")) {
      return;
    }
    mode = nextMode;
    localStorage.setItem(MODE_KEY, mode);
    if (newLevel) {
      if (mode === "classic") {
        state.active = makeClassicGame(state.highestUnlockedLevel);
      } else {
        state.activeMeow = makeMeowGame(state.meowHighestUnlockedLevel);
      }
    }
    selectedCell = null;
    selectedValue = null;
    undoStack = [];
    elements.feedback.textContent = "";
    saveState();
    showScreen("game");
  }

  function renderHome() {
    const name = state.settings.playerName.trim();
    document.querySelector("#welcome-title").textContent =
      name ? `Привет, ${name}!` : "Привет, котолюб!";
    document.querySelector("#continue-classic-button").textContent =
      `Продолжить · уровень ${state.active?.level.number || state.highestUnlockedLevel}`;
    document.querySelector("#continue-meow-button").textContent =
      `Продолжить · уровень ${state.activeMeow?.puzzle.number || state.meowHighestUnlockedLevel}`;
    const history = document.querySelector("#home-history");
    history.replaceChildren();
    const entries = state.completed.slice(-5).reverse();
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.textContent = "Победы появятся здесь.";
      history.append(empty);
    }
    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "history-item";
      const title = document.createElement("span");
      title.textContent = `Судоку · уровень ${entry.number}`;
      const result = document.createElement("span");
      result.textContent = `${entry.size}×${entry.size} · ${entry.hintsUsed || 0} подсказок`;
      row.append(title, result);
      history.append(row);
    });
    document.querySelector(".history-panel").hidden =
      !document.querySelector("#history-button").dataset.expanded;
    renderCompanions(document.querySelector("#home-companions"));
  }

  function renderSettings() {
    const settings = state.settings;
    document.querySelector("#player-name").value = settings.playerName || "";
    document.querySelector("#player-gender").value = settings.playerGender || "UNSPECIFIED";
    document.querySelector("#theme-mode").value = settings.themeMode || "SYSTEM";
    document.querySelector("#color-palette").value = settings.colorPalette || "STANDARD";
    document.querySelector("#music-enabled").checked = settings.musicEnabled !== false;
    document.querySelector("#sounds-enabled").checked = settings.uiSoundsEnabled !== false;
    const musicVolume = Math.round((Number(settings.musicVolume) || 0) * 100);
    const soundsVolume = Math.round((Number(settings.uiVolume) || 0) * 100);
    document.querySelector("#music-volume").value = String(musicVolume);
    document.querySelector("#sounds-volume").value = String(soundsVolume);
    document.querySelector("#music-volume-value").value = `${musicVolume}%`;
    document.querySelector("#sounds-volume-value").value = `${soundsVolume}%`;
    renderCompanions(document.querySelector("#settings-companions"));
  }

  function renderCompanions(container) {
    container.replaceChildren();
    state.settings.catBuddies.forEach((cat) => {
      const card = document.createElement("article");
      card.className = "companion-card";
      const heading = document.createElement("div");
      heading.className = "companion-heading";
      const image = document.createElement("img");
      image.className = "companion-cat-image";
      image.src = `./assets/cat_${cat.isGray ? "gray" : "light"}_${
        cat.isSleeping ? "sleeping" : "awake"
      }.png`;
      image.alt = cat.name;
      const meta = document.createElement("div");
      meta.className = "companion-meta";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "companion-name";
      name.dataset.catAction = "rename";
      name.dataset.catId = cat.id;
      name.textContent = cat.name;
      const status = document.createElement("p");
      status.className = "companion-status";
      status.textContent = cat.isSleeping ? "Спит" : "Бодрствует";
      meta.append(name, status);
      heading.append(image, meta);

      const actions = document.createElement("div");
      actions.className = "companion-actions";
      const buttons = [
        [cat.isSleeping ? "Будить" : "Спать", "sleep"],
        [audio.purrPlayer?.id === cat.id ? "Тише" : "Мурр", "purr"],
        ["Мяу", "meow"],
        ["Убрать", "delete"]
      ];
      buttons.forEach(([label, action]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cat-action-button";
        button.dataset.catAction = action;
        button.dataset.catId = cat.id;
        button.textContent = label;
        button.disabled = action === "meow" && cat.isSleeping;
        actions.append(button);
      });
      card.append(heading, actions);
      container.append(card);
    });
  }

  function renderGameCompanions() {
    renderCompanions(gameCompanionsList);
    gameCompanionsCount.textContent = `(${state.settings.catBuddies.length})`;
    gameCompanionsToggle.setAttribute("aria-expanded", String(gameCompanionsExpanded));
    gameCompanionsList.hidden = compactLayout.matches && !gameCompanionsExpanded;
  }

  function saveSettings() {
    saveState();
    applyTheme();
    audio.updateSettings(state.settings);
    renderHome();
    if (visibleScreen === "settings") renderCompanions(document.querySelector("#settings-companions"));
  }

  function editCat(cat) {
    catBeingEdited = cat?.id || null;
    document.querySelector("#cat-dialog-title").textContent = cat ? "Переименовать котика" : "Новый котик";
    document.querySelector("#cat-name").value = cat?.name || "";
    document.querySelector("#cat-color").value = cat?.isGray ? "gray" : "light";
    catDialog.showModal();
    document.querySelector("#cat-name").focus();
  }

  function handleCatAction(action, id) {
    const cat = state.settings.catBuddies.find((item) => item.id === id);
    if (!cat) return;
    if (action === "rename") {
      editCat(cat);
      return;
    }
    if (action === "sleep") {
      cat.isSleeping = !cat.isSleeping;
      if (cat.isSleeping) audio.stopPurr(cat.id);
    } else if (action === "purr") {
      if (audio.purrPlayer?.id === cat.id) audio.stopPurr(cat.id);
      else audio.playPurr(cat);
    } else if (action === "meow") {
      audio.playMeow(cat);
    } else if (action === "delete") {
      if (!window.confirm(`Убрать котика «${cat.name}»?`)) return;
      audio.stopPurr(cat.id);
      state.settings.catBuddies = state.settings.catBuddies.filter((item) => item.id !== id);
    }
    saveSettings();
    renderGameCompanions();
  }

  function completionPraise() {
    const name = state.settings.playerName.trim();
    const suffix = name ? `, ${name}` : "";
    const female = state.settings.playerGender === "FEMALE";
    const male = state.settings.playerGender === "MALE";
    const phrases = [
      `Умничкаааа${suffix}, ты просто чудо!`,
      `Вот это да${suffix}! Котики тобой гордятся!`,
      `Потрясающе ${female ? "справилась" : male ? "справился" : "справился(ась)"}${suffix}! Уровень покорён!`,
      `Муррр-молодец${suffix}! Ты блестяще ${female ? "решила" : male ? "решил" : "решил(а)"} задачку!`,
      `Лапки вверх${suffix} — и задачка решена! Какой острый ум!`,
      `Ура${suffix}! Ещё одна победа в твою копилочку!`
    ];
    return phrases[randomInt(phrases.length)];
  }

  function announceVictory() {
    document.querySelector("#victory-title").textContent =
      `Уровень ${mode === "classic" ? state.active.level.number : state.activeMeow.puzzle.number} пройден!`;
    document.querySelector("#victory-message").textContent = completionPraise();
    audio.playEffect("ui_success");
    if (!victoryDialog.open) victoryDialog.showModal();
  }

  function markMeowSwipe(indices) {
    const game = state.activeMeow;
    let changed = false;
    indices.forEach((index) => {
      if (!meowCellIsGiven(game, index) && !game.board[index] && !game.xMarks[index]) {
        recordMeowUndo(index);
        game.xMarks[index] = true;
        changed = true;
      }
    });
    if (!changed) return;
    selectedCell = indices[indices.length - 1];
    saveState();
    render();
  }

  function cellsBetween(first, last) {
    let x = first % 8;
    let y = Math.floor(first / 8);
    const targetX = last % 8;
    const targetY = Math.floor(last / 8);
    const dx = Math.abs(targetX - x);
    const sx = x < targetX ? 1 : -1;
    const dy = -Math.abs(targetY - y);
    const sy = y < targetY ? 1 : -1;
    let error = dx + dy;
    const cells = [];
    while (true) {
      cells.push(y * 8 + x);
      if (x === targetX && y === targetY) return cells;
      const doubledError = 2 * error;
      if (doubledError >= dy) {
        error += dy;
        x += sx;
      }
      if (doubledError <= dx) {
        error += dx;
        y += sy;
      }
    }
  }

  function meowCellFromPoint(x, y) {
    const target = document.elementFromPoint(x, y)?.closest("[data-cell]");
    return target ? Number(target.dataset.cell) : null;
  }

  function randomInt(max) {
    return Math.floor(Math.random() * max);
  }

  function shuffled(items) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index--) {
      const other = randomInt(index + 1);
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }

  function classicSize(level) {
    if (level <= 4) return { order: 4, boxRows: 2, boxColumns: 2 };
    return { order: 6, boxRows: 2, boxColumns: 3 };
  }

  function makeSolvedSudoku(size) {
    const { order, boxRows, boxColumns } = size;
    const rows = shuffled(Array.from({ length: order / boxRows }, (_, group) => group))
      .flatMap((group) => shuffled(
        Array.from({ length: boxRows }, (_, offset) => group * boxRows + offset)
      ));
    const columns = shuffled(Array.from({ length: order / boxColumns }, (_, group) => group))
      .flatMap((group) => shuffled(
        Array.from({ length: boxColumns }, (_, offset) => group * boxColumns + offset)
      ));
    const values = shuffled(Array.from({ length: order }, (_, index) => index + 1));
    const pattern = (row, column) =>
      (boxColumns * (row % boxRows) + Math.floor(row / boxRows) + column) % order;
    return rows.flatMap((row) =>
      columns.map((column) => values[pattern(row, column)])
    );
  }

  function sudokuCandidates(size, board, index) {
    const { order, boxRows, boxColumns } = size;
    const row = Math.floor(index / order);
    const column = index % order;
    const used = new Set();
    for (let offset = 0; offset < order; offset++) {
      used.add(board[row * order + offset]);
      used.add(board[offset * order + column]);
    }
    const rowStart = Math.floor(row / boxRows) * boxRows;
    const columnStart = Math.floor(column / boxColumns) * boxColumns;
    for (let r = rowStart; r < rowStart + boxRows; r++) {
      for (let c = columnStart; c < columnStart + boxColumns; c++) {
        used.add(board[r * order + c]);
      }
    }
    return Array.from({ length: order }, (_, value) => value + 1)
      .filter((value) => !used.has(value));
  }

  function countSudokuSolutions(size, board, limit = 2) {
    let count = 0;
    const working = board.slice();

    function search() {
      if (count >= limit) return;
      let bestIndex = -1;
      let bestCandidates = null;
      for (let index = 0; index < working.length; index++) {
        if (working[index] !== 0) continue;
        const candidates = sudokuCandidates(size, working, index);
        if (candidates.length === 0) return;
        if (bestCandidates === null || candidates.length < bestCandidates.length) {
          bestIndex = index;
          bestCandidates = candidates;
          if (candidates.length === 1) break;
        }
      }
      if (bestIndex === -1) {
        count++;
        return;
      }
      for (const value of bestCandidates) {
        working[bestIndex] = value;
        search();
        working[bestIndex] = 0;
        if (count >= limit) return;
      }
    }

    search();
    return count;
  }

  function targetEmptyCells(level, order) {
    if (level <= 4) return [1, 3, 4, 6][level - 1];
    if (level <= 12) return 8 + (level - 5) * 2;
    return Math.min(24 + (level - 13) * 2, order * order - 17);
  }

  function makeClassicGame(levelNumber) {
    const size = classicSize(levelNumber);
    const solution = makeSolvedSudoku(size);
    const puzzle = solution.slice();
    const removals = shuffled(puzzle.map((_, index) => index));
    const target = targetEmptyCells(levelNumber, size.order);
    let removed = 0;
    for (const index of removals) {
      if (removed >= target) break;
      const original = puzzle[index];
      puzzle[index] = 0;
      if (countSudokuSolutions(size, puzzle, 2) === 1) {
        removed++;
      } else {
        puzzle[index] = original;
      }
    }
    const now = Date.now();
    return {
      level: {
        number: levelNumber,
        ...size,
        puzzle,
        solution,
        seed: now,
        score: 0,
        singles: 0,
        searchNodes: 0,
        maxSearchDepth: 0
      },
      board: puzzle.slice(),
      startedAt: now,
      hintsUsed: 0,
      mistakes: 0
    };
  }

  function makeMeowSolution() {
    let columns = null;
    for (let attempt = 0; attempt < 10000; attempt++) {
      const candidate = shuffled(Array.from({ length: 8 }, (_, index) => index));
      if (candidate.slice(1).every((column, index) =>
        Math.abs(column - candidate[index]) > 1
      )) {
        columns = candidate;
        break;
      }
    }
    if (!columns) throw new Error("Не удалось создать поле кото-логики.");
    const solution = Array(64).fill(0);
    columns.forEach((column, row) => { solution[row * 8 + column] = 1; });
    return solution;
  }

  function regionFrontier(regions, region) {
    const frontier = [];
    for (let index = 0; index < 64; index++) {
      if (regions[index] !== -1) continue;
      const row = Math.floor(index / 8);
      const column = index % 8;
      if ((row > 0 && regions[index - 8] === region) ||
          (row < 7 && regions[index + 8] === region) ||
          (column > 0 && regions[index - 1] === region) ||
          (column < 7 && regions[index + 1] === region)) {
        frontier.push(index);
      }
    }
    return frontier;
  }

  function makeMeowRegions(solution) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const regions = Array(64).fill(-1);
      const sizes = Array(8).fill(0);
      for (let row = 0; row < 8; row++) {
        const seed = solution.findIndex((value, index) => value === 1 &&
          Math.floor(index / 8) === row);
        regions[seed] = row;
        sizes[row] = 1;
      }
      let assigned = 8;
      while (assigned < 64) {
        const expandable = Array.from({ length: 8 }, (_, index) => index)
          .filter((region) => sizes[region] < 8 && regionFrontier(regions, region).length);
        if (!expandable.length) break;
        const smallest = Math.min(...expandable.map((region) => sizes[region]));
        const choices = expandable.filter((region) => sizes[region] === smallest);
        const region = choices[randomInt(choices.length)];
        const frontier = regionFrontier(regions, region);
        regions[frontier[randomInt(frontier.length)]] = region;
        sizes[region]++;
        assigned++;
      }
      if (assigned === 64 && sizes.every((size) => size === 8)) return regions;
    }
    return Array.from({ length: 64 }, (_, index) => Math.floor(index / 8));
  }

  function makeMeowGame(levelNumber) {
    const solution = makeMeowSolution();
    const regions = makeMeowRegions(solution);
    const difficulty = ["HARD", "MEDIUM", "NORMAL"][randomInt(3)];
    const clueCount = { NORMAL: 3, MEDIUM: 2, HARD: 1 }[difficulty];
    const givens = Array(64).fill(0);
    shuffled(solution.flatMap((value, index) => value ? [index] : []))
      .slice(0, clueCount)
      .forEach((index) => { givens[index] = 1; });
    const now = Date.now();
    return {
      puzzle: { number: levelNumber, difficulty, regions, solution, givens },
      board: givens.slice(),
      xMarks: Array(64).fill(false),
      startedAt: now
    };
  }

  function classicConflicts(game) {
    const { order, boxRows, boxColumns } = game.level;
    const conflicts = new Set();
    for (let index = 0; index < game.board.length; index++) {
      const value = game.board[index];
      if (!value) continue;
      const row = Math.floor(index / order);
      const column = index % order;
      for (let other = index + 1; other < game.board.length; other++) {
        if (game.board[other] !== value) continue;
        const otherRow = Math.floor(other / order);
        const otherColumn = other % order;
        const sameRow = row === otherRow;
        const sameColumn = column === otherColumn;
        const sameBox = Math.floor(row / boxRows) === Math.floor(otherRow / boxRows) &&
          Math.floor(column / boxColumns) === Math.floor(otherColumn / boxColumns);
        if (sameRow || sameColumn || sameBox ||
            (game.level.puzzle[index] === 0 && value !== game.level.solution[index]) ||
            (game.level.puzzle[other] === 0 && game.board[other] !== game.level.solution[other])) {
          conflicts.add(index);
          conflicts.add(other);
        }
      }
    }
    for (let index = 0; index < game.board.length; index++) {
      if (game.level.puzzle[index] === 0 && game.board[index] &&
          game.board[index] !== game.level.solution[index]) conflicts.add(index);
    }
    return conflicts;
  }

  function meowConflicts(game) {
    const conflicts = new Set();
    const cats = game.board.flatMap((value, index) => value ? [index] : []);
    cats.forEach((first, position) => {
      for (const second of cats.slice(position + 1)) {
        const firstRow = Math.floor(first / 8);
        const firstColumn = first % 8;
        const secondRow = Math.floor(second / 8);
        const secondColumn = second % 8;
        if (firstRow === secondRow || firstColumn === secondColumn ||
            game.puzzle.regions[first] === game.puzzle.regions[second] ||
            (Math.abs(firstRow - secondRow) === 1 &&
             Math.abs(firstColumn - secondColumn) === 1)) {
          conflicts.add(first);
          conflicts.add(second);
        }
      }
    });
    return conflicts;
  }

  function isClassicSolved(game) {
    return game.board.every((value, index) => value === game.level.solution[index]);
  }

  function isMeowSolved(game) {
    if (game.board.filter(Boolean).length !== 8 || meowConflicts(game).size) return false;
    for (let region = 0; region < 8; region++) {
      if (game.board.filter((value, index) =>
        value && game.puzzle.regions[index] === region
      ).length !== 1) return false;
    }
    for (let row = 0; row < 8; row++) {
      if (game.board.slice(row * 8, row * 8 + 8).filter(Boolean).length !== 1) return false;
      if (game.board.filter((_, index) => index % 8 === row).filter(Boolean).length !== 1) {
        return false;
      }
    }
    return true;
  }

  function activeGame() {
    return mode === "classic" ? state.active : state.activeMeow;
  }

  function classicCellIsGiven(game, index) {
    return game.level.puzzle[index] !== 0;
  }

  function meowCellIsGiven(game, index) {
    return game.puzzle.givens[index] === 1;
  }

  function catImage(value, description = "Котик") {
    const image = document.createElement("img");
    image.src = `./assets/cat_symbol_${value}.png`;
    image.alt = description;
    image.draggable = false;
    return image;
  }

  function render() {
    const game = activeGame();
    const isMeow = mode === "meow";
    const order = isMeow ? 8 : game.level.order;
    const conflicts = isMeow ? meowConflicts(game) : classicConflicts(game);
    const complete = isMeow ? isMeowSolved(game) : isClassicSolved(game);

    document.querySelectorAll(".mode-button").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === mode);
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    });
    gameShell.classList.toggle("meow-mode", isMeow);

    elements.title.textContent = `Уровень ${isMeow ? game.puzzle.number : game.level.number}`;
    elements.subtitle.textContent = isMeow
      ? ({ NORMAL: "Лёгкая", MEDIUM: "Средняя", HARD: "Сложная", ULTRA: "Ультра" }[
        game.puzzle.difficulty
      ] || "Кото-логика")
      : `${order}×${order} · ${game.level.number <= 4 ? "Мягкая" :
        game.level.number <= 8 ? "Лёгкая" :
        game.level.number <= 16 ? "Средняя" : "Сложная"}`;
    elements.count.textContent = isMeow
      ? `${game.board.filter(Boolean).length} / 8 котиков`
      : `Осталось поставить: ${game.board.filter((value) => !value).length}`;
    elements.rules.textContent = isMeow
      ? "По одному котику в каждой строке, колонке и цветном регионе; котики не касаются по диагонали."
      : "В каждой строке, колонке и блоке каждый котик встречается один раз.";
    elements.board.style.setProperty("--board-size", order);
    elements.board.style.touchAction = isMeow ? "none" : "manipulation";
    elements.board.setAttribute("aria-label", `${order} на ${order}`);

    elements.board.replaceChildren();
    game.board.forEach((value, index) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.cell = String(index);
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", `Строка ${Math.floor(index / order) + 1}, столбец ${
        index % order + 1
      }`);
      const row = Math.floor(index / order);
      const column = index % order;
      if (selectedCell === index) cell.classList.add("selected");
      if (conflicts.has(index)) cell.classList.add("conflict");
      if (isMeow) {
        cell.classList.add("region-cell");
        cell.style.setProperty("--cell-color", REGION_COLORS[game.puzzle.regions[index]]);
        if (column < order - 1 &&
            game.puzzle.regions[index] !== game.puzzle.regions[index + 1]) {
          cell.classList.add("box-right");
        }
        if (row < order - 1 &&
            game.puzzle.regions[index] !== game.puzzle.regions[index + order]) {
          cell.classList.add("box-bottom");
        }
        if (meowCellIsGiven(game, index)) cell.classList.add("given");
        if (value) cell.append(catImage(1));
        else if (game.xMarks[index]) {
          const mark = document.createElement("span");
          mark.className = "cell-x";
          mark.textContent = "×";
          cell.append(mark);
        }
      } else {
        cell.classList.add("classic-cell");
        if (classicCellIsGiven(game, index)) cell.classList.add("given");
        if ((column + 1) % game.level.boxColumns === 0 && column < order - 1) {
          cell.classList.add("box-right");
        }
        if ((row + 1) % game.level.boxRows === 0 && row < order - 1) {
          cell.classList.add("box-bottom");
        }
        if (value) cell.append(catImage(value));
        if (selectedValue && !classicCellIsGiven(game, index) && !value) {
          cell.classList.add("available");
        }
      }
      elements.board.append(cell);
    });

    renderPicker(game, isMeow, order);
    renderActions(game, isMeow, complete);
    renderGameCompanions();
    if (complete) {
      elements.feedback.textContent = "Уровень пройден! Можно перейти к следующему.";
    }
  }

  function renderPicker(game, isMeow, order) {
    elements.picker.replaceChildren();
    if (isMeow) return;
    for (let value = 1; value <= order; value++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cat-choice";
      button.dataset.value = String(value);
      button.setAttribute("aria-label", `Выбрать котика ${value}`);
      button.setAttribute("aria-pressed", String(selectedValue === value));
      if (selectedValue === value) button.classList.add("selected");
      button.append(catImage(value, `Котик ${value}`));
      elements.picker.append(button);
    }
  }

  function actionButton(label, action, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `action-button${options.primary ? " primary" : ""}`;
    button.dataset.action = action;
    button.textContent = label;
    button.disabled = Boolean(options.disabled);
    elements.actions.append(button);
  }

  function renderActions(game, isMeow, complete) {
    elements.actions.replaceChildren();
    if (isMeow) {
      const canPlace = selectedCell !== null && !meowCellIsGiven(game, selectedCell);
      actionButton(game.board[selectedCell] ? "Убрать котика" : "Поставить котика",
        "place-meow", { disabled: !canPlace, primary: true });
      actionButton("Отметить X", "mark-x", {
        disabled: selectedCell === null || game.board[selectedCell] === 1
      });
      actionButton("Подсказка", "hint", { disabled: game.puzzle.difficulty === "ULTRA" });
      actionButton("Отменить", "undo", { disabled: undoStack.length === 0 });
      actionButton(complete ? "Следующий уровень" : "Новый уровень", "next", {
        primary: complete
      });
    } else {
      const canEdit = selectedCell !== null && !classicCellIsGiven(game, selectedCell);
      actionButton("Очистить", "clear", {
        disabled: !canEdit || game.board[selectedCell] === 0
      });
      actionButton("Подсказка", "hint", {
        disabled: !canEdit || game.board[selectedCell] === game.level.solution[selectedCell]
      });
      actionButton("Отменить", "undo", { disabled: undoStack.length === 0 });
      actionButton(complete ? "Следующий уровень" : "Новый уровень", "next", {
        primary: complete
      });
    }
  }

  function chooseClassicValue(value) {
    selectedValue = value;
    const game = state.active;
    if (selectedCell !== null && !classicCellIsGiven(game, selectedCell)) {
      setClassicValue(value);
      return;
    }
    renderHome();
    renderSettings();
    render();
    audio.updateSettings(state.settings);
  }

  function setClassicValue(value) {
    const game = state.active;
    if (selectedCell === null || classicCellIsGiven(game, selectedCell)) return;
    const wasSolved = isClassicSolved(game);
    undoStack.push({ mode: "classic", index: selectedCell, value: game.board[selectedCell] });
    game.board[selectedCell] = value;
    audio.playEffect("ui_number_input");
    if (value !== game.level.solution[selectedCell]) game.mistakes++;
    selectedValue = null;
    updateClassicCompletion();
    if (!wasSolved && isClassicSolved(game)) announceVictory();
    saveState();
    render();
  }

  function updateClassicCompletion() {
    const game = state.active;
    if (!isClassicSolved(game)) return;
    const number = game.level.number;
    if (!state.completed.some((entry) => entry.number === number)) {
      state.completed.push({
        number,
        size: game.level.order,
        difficulty: elements.subtitle.textContent,
        durationMillis: Math.max(0, Date.now() - game.startedAt),
        completedAt: Date.now(),
        hintsUsed: game.hintsUsed,
        mistakes: game.mistakes,
        snapshot: structuredClone(game.level)
      });
    }
    state.highestUnlockedLevel = Math.max(state.highestUnlockedLevel, number + 1);
  }

  function recordMeowUndo(index) {
    const game = state.activeMeow;
    undoStack.push({
      mode: "meow",
      index,
      boardValue: game.board[index],
      xMarkValue: game.xMarks[index]
    });
  }

  function finishMeowIfSolved() {
    if (isMeowSolved(state.activeMeow)) {
      state.meowHighestUnlockedLevel = Math.max(
        state.meowHighestUnlockedLevel,
        state.activeMeow.puzzle.number + 1
      );
    }
  }

  function handleCell(index) {
    const game = activeGame();
    if (mode === "classic") {
      selectedCell = index;
      audio.playEffect("ui_cell_select");
      if (selectedValue && !classicCellIsGiven(game, index)) {
        setClassicValue(selectedValue);
        return;
      }
    } else {
      selectedCell = index;
      const now = Date.now();
      if (pendingMeowTap && pendingMeowTap.index === index &&
          now - pendingMeowTap.time < 320) {
        window.clearTimeout(pendingMeowTap.timeout);
        pendingMeowTap = null;
        if (!meowCellIsGiven(game, index)) {
          const wasSolved = isMeowSolved(game);
          recordMeowUndo(index);
          game.board[index] = game.board[index] ? 0 : 1;
          if (game.board[index]) game.xMarks[index] = false;
          finishMeowIfSolved();
          audio.playEffect("ui_cell_select");
          if (!wasSolved && isMeowSolved(game)) announceVictory();
          saveState();
        }
        render();
        return;
      }
      if (pendingMeowTap) window.clearTimeout(pendingMeowTap.timeout);
      const timeout = window.setTimeout(() => {
        if (!meowCellIsGiven(game, index) && !game.board[index] && !game.xMarks[index]) {
          recordMeowUndo(index);
          game.xMarks[index] = true;
          saveState();
        }
        pendingMeowTap = null;
        render();
      }, 320);
      pendingMeowTap = { index, time: now, timeout };
    }
    render();
  }

  function handleAction(action) {
    const game = activeGame();
    if (action === "next") {
      const complete = mode === "classic" ? isClassicSolved(game) : isMeowSolved(game);
      if (!complete && !window.confirm("Начать новый уровень? Текущий незавершённый ход будет заменён.")) {
        return;
      }
      if (mode === "classic") {
        state.active = makeClassicGame(Math.max(game.level.number + 1, state.highestUnlockedLevel));
      } else {
        state.activeMeow = makeMeowGame(
          Math.max(game.puzzle.number + 1, state.meowHighestUnlockedLevel)
        );
      }
      selectedCell = null;
      selectedValue = null;
      undoStack = [];
      elements.feedback.textContent = "";
      saveState();
      render();
      audio.playEffect("ui_button");
      return;
    }

    const wasSolved = mode === "classic" ? isClassicSolved(game) : isMeowSolved(game);
    if (mode === "classic") {
      if (action === "clear" && selectedCell !== null &&
          !classicCellIsGiven(game, selectedCell)) {
        undoStack.push({ mode: "classic", index: selectedCell, value: game.board[selectedCell] });
        game.board[selectedCell] = 0;
      } else if (action === "hint" && selectedCell !== null &&
          !classicCellIsGiven(game, selectedCell)) {
        undoStack.push({ mode: "classic", index: selectedCell, value: game.board[selectedCell] });
        game.board[selectedCell] = game.level.solution[selectedCell];
        game.hintsUsed++;
        updateClassicCompletion();
      } else if (action === "undo") {
        const previous = undoStack.pop();
        if (previous?.mode === "classic") game.board[previous.index] = previous.value;
      }
    } else if (action === "place-meow" && selectedCell !== null &&
        !meowCellIsGiven(game, selectedCell)) {
      recordMeowUndo(selectedCell);
      game.board[selectedCell] = game.board[selectedCell] ? 0 : 1;
      if (game.board[selectedCell]) game.xMarks[selectedCell] = false;
      finishMeowIfSolved();
    } else if (action === "mark-x" && selectedCell !== null) {
      recordMeowUndo(selectedCell);
      game.xMarks[selectedCell] = !game.xMarks[selectedCell];
    } else if (action === "hint" && game.puzzle.difficulty !== "ULTRA") {
      const index = game.puzzle.solution.findIndex((value, cell) =>
        value === 1 && game.board[cell] === 0 && !meowCellIsGiven(game, cell)
      );
      if (index >= 0) {
        recordMeowUndo(index);
        game.board[index] = 1;
        game.xMarks[index] = false;
        selectedCell = index;
        finishMeowIfSolved();
      }
    } else if (action === "undo") {
      const previous = undoStack.pop();
      if (previous?.mode === "meow") {
        state.activeMeow.board[previous.index] = previous.boardValue;
        state.activeMeow.xMarks[previous.index] = previous.xMarkValue;
      }
    }
    const solved = mode === "classic" ? isClassicSolved(game) : isMeowSolved(game);
    if (!wasSolved && solved) announceVictory();
    saveState();
    render();
  }

  function isValidClassicBoard(size, board) {
    const { order, boxRows, boxColumns } = size;
    if (!Array.isArray(board) || board.length !== order * order ||
        board.some((value) => !Number.isInteger(value) || value < 0 || value > order)) {
      return false;
    }
    for (let index = 0; index < board.length; index++) {
      const value = board[index];
      if (!value) continue;
      const row = Math.floor(index / order);
      const column = index % order;
      for (let other = index + 1; other < board.length; other++) {
        if (board[other] !== value) continue;
        const otherRow = Math.floor(other / order);
        const otherColumn = other % order;
        if (row === otherRow || column === otherColumn ||
            (Math.floor(row / boxRows) === Math.floor(otherRow / boxRows) &&
             Math.floor(column / boxColumns) === Math.floor(otherColumn / boxColumns))) {
          return false;
        }
      }
    }
    return true;
  }

  function isValidSavedLevel(level) {
    if (!level || !Number.isInteger(level.number) || level.number < 1) return false;
    const size = {
      order: level.order,
      boxRows: level.boxRows,
      boxColumns: level.boxColumns
    };
    const validSize = size.order === 4 && size.boxRows === 2 && size.boxColumns === 2 ||
      size.order === 6 && size.boxRows === 2 && size.boxColumns === 3 ||
      size.order === 9 && size.boxRows === 3 && size.boxColumns === 3;
    return validSize &&
      isValidClassicBoard(size, level.puzzle) &&
      isValidClassicBoard(size, level.solution) &&
      level.solution.every((value) => value !== 0) &&
      level.puzzle.every((value, index) => !value || value === level.solution[index]);
  }

  function isValidMeowSolution(board, regions) {
    if (!Array.isArray(board) || board.length !== 64 ||
        !Array.isArray(regions) || regions.length !== 64 ||
        board.some((value) => value !== 0 && value !== 1) ||
        regions.some((region) => !Number.isInteger(region) || region < 0 || region > 7) ||
        Array.from({ length: 8 }, (_, region) =>
          regions.filter((value) => value === region).length
        ).some((count) => count !== 8)) return false;
    for (let row = 0; row < 8; row++) {
      const column = board.slice(row * 8, row * 8 + 8).indexOf(1);
      if (column < 0 || board.slice(row * 8, row * 8 + 8).filter(Boolean).length !== 1) {
        return false;
      }
      if (row > 0) {
        const previousColumn = board.slice((row - 1) * 8, row * 8).indexOf(1);
        if (Math.abs(previousColumn - column) <= 1) return false;
      }
    }
    for (let column = 0; column < 8; column++) {
      if (board.filter((_, index) => index % 8 === column).filter(Boolean).length !== 1) {
        return false;
      }
    }
    return Array.from({ length: 8 }, (_, region) =>
      board.filter((value, index) => value && regions[index] === region).length
    ).every((count) => count === 1);
  }

  function isValidSave(candidate) {
    if (!candidate || candidate.schemaVersion !== 1 ||
        !Array.isArray(candidate.completed) ||
        !Number.isInteger(candidate.highestUnlockedLevel) ||
        candidate.highestUnlockedLevel < 1 ||
        !Number.isInteger(candidate.meowHighestUnlockedLevel) ||
        candidate.meowHighestUnlockedLevel < 1) return false;

    if (candidate.active !== null) {
      const game = candidate.active;
      const level = game?.level;
      const size = level && { order: level.order };
      if (!isValidSavedLevel(level) ||
          !Array.isArray(game.board) || game.board.length !== size.order * size.order ||
          game.board.some((value) => !Number.isInteger(value) || value < 0 || value > size.order) ||
          level.puzzle.some((value, index) => value && game.board[index] !== value)) return false;
    }

    if (candidate.activeMeow !== null) {
      const game = candidate.activeMeow;
      const puzzle = game?.puzzle;
      if (!puzzle || !Number.isInteger(puzzle.number) || puzzle.number < 1 ||
          !["NORMAL", "MEDIUM", "HARD", "ULTRA"].includes(puzzle.difficulty) ||
          !isValidMeowSolution(puzzle.solution, puzzle.regions) ||
          !Array.isArray(puzzle.givens) || puzzle.givens.length !== 64 ||
          !Array.isArray(game.board) || game.board.length !== 64 ||
          !Array.isArray(game.xMarks) || game.xMarks.length !== 64 ||
          game.board.some((value) => value !== 0 && value !== 1) ||
          puzzle.givens.some((value, index) =>
            (value !== 0 && value !== 1) ||
            (value && value !== puzzle.solution[index]) ||
            (value && !game.board[index])
          ) || game.xMarks.some((mark) => typeof mark !== "boolean")) return false;
    }
    if (candidate.completed.some((entry) =>
      !entry || !Number.isInteger(entry.number) || entry.number < 1 ||
      !Number.isInteger(entry.size) ||
      !Number.isFinite(entry.durationMillis) ||
      !Number.isFinite(entry.completedAt) ||
      !isValidSavedLevel(entry.snapshot) ||
      entry.snapshot.number !== entry.number ||
      entry.snapshot.order !== entry.size
    )) return false;
    if (candidate.settings &&
        ((candidate.settings.themeMode !== undefined &&
          !["SYSTEM", "LIGHT", "DARK"].includes(candidate.settings.themeMode)) ||
         (candidate.settings.colorPalette !== undefined &&
          !["STANDARD", "SOFT_PASTEL"].includes(candidate.settings.colorPalette)) ||
         (candidate.settings.playerGender !== undefined &&
          !["UNSPECIFIED", "FEMALE", "MALE"].includes(candidate.settings.playerGender)))) {
      return false;
    }
    return true;
  }

  function exportProgress() {
    const contents = JSON.stringify(state, null, 2);
    const file = new Blob([contents], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = "mellowoku-progress.json";
    link.click();
    URL.revokeObjectURL(url);
    elements.feedback.textContent = "Файл прогресса скачан.";
  }

  async function importProgress(file) {
    try {
      const candidate = JSON.parse(await file.text());
      if (!isValidSave(candidate)) {
        throw new Error("Файл не является корректным сохранением Mellowoku.");
      }
      state = {
        ...defaultState(),
        ...candidate,
        settings: candidate.settings || structuredClone(DEFAULT_SETTINGS)
      };
      selectedCell = null;
      selectedValue = null;
      undoStack = [];
      saveState();
      elements.feedback.textContent = "Прогресс восстановлен из файла.";
      render();
    } catch (error) {
      elements.feedback.textContent = error instanceof Error
        ? error.message
        : "Не удалось прочитать файл прогресса.";
    } finally {
      elements.importFile.value = "";
    }
  }

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      mode = button.dataset.mode;
      localStorage.setItem(MODE_KEY, mode);
      selectedCell = null;
      selectedValue = null;
      undoStack = [];
      elements.feedback.textContent = "";
      audio.playEffect("ui_button");
      render();
    });
  });

  elements.board.addEventListener("click", (event) => {
    if (Date.now() < suppressBoardClickUntil) return;
    const cell = event.target.closest("[data-cell]");
    if (cell) handleCell(Number(cell.dataset.cell));
  });
  elements.board.addEventListener("pointerdown", (event) => {
    if (mode !== "meow" || event.button !== 0) return;
    const index = meowCellFromPoint(event.clientX, event.clientY);
    if (index === null) return;
    pointerGesture = { pointerId: event.pointerId, lastIndex: index, cells: [index] };
    elements.board.setPointerCapture(event.pointerId);
  });
  elements.board.addEventListener("pointermove", (event) => {
    if (!pointerGesture || pointerGesture.pointerId !== event.pointerId) return;
    const index = meowCellFromPoint(event.clientX, event.clientY);
    if (index === null || index === pointerGesture.lastIndex) return;
    pointerGesture.cells.push(...cellsBetween(pointerGesture.lastIndex, index).slice(1));
    pointerGesture.lastIndex = index;
  });
  elements.board.addEventListener("pointerup", (event) => {
    if (!pointerGesture || pointerGesture.pointerId !== event.pointerId) return;
    const cells = pointerGesture.cells;
    pointerGesture = null;
    suppressBoardClickUntil = Date.now() + 500;
    if (new Set(cells).size > 1) {
      if (pendingMeowTap) window.clearTimeout(pendingMeowTap.timeout);
      pendingMeowTap = null;
      markMeowSwipe(cells);
    } else {
      handleCell(cells[0]);
    }
  });
  elements.board.addEventListener("pointercancel", () => {
    pointerGesture = null;
  });

  elements.picker.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-value]");
    if (choice) {
      audio.playEffect("ui_number_input");
      chooseClassicValue(Number(choice.dataset.value));
    }
  });

  elements.actions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (button && !button.disabled) handleAction(button.dataset.action);
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    void audio.unlock();
    if (button.closest("#board") || button.closest("#cat-picker")) return;
    if (!button.dataset.catAction) audio.playEffect("ui_button");
  }, true);

  document.querySelector("#new-classic-button").addEventListener("click", () =>
    startGame("classic", true));
  document.querySelector("#continue-classic-button").addEventListener("click", () =>
    startGame("classic"));
  document.querySelector("#new-meow-button").addEventListener("click", () =>
    startGame("meow", true));
  document.querySelector("#continue-meow-button").addEventListener("click", () =>
    startGame("meow"));
  document.querySelector("#settings-button").addEventListener("click", () =>
    showScreen("settings"));
  document.querySelector("#history-button").addEventListener("click", (event) => {
    const panel = document.querySelector(".history-panel");
    panel.hidden = !panel.hidden;
    event.currentTarget.dataset.expanded = panel.hidden ? "" : "true";
    if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  document.querySelector("#back-home-button").addEventListener("click", () => showScreen("home"));
  document.querySelectorAll("[data-go-home]").forEach((button) => {
    button.addEventListener("click", () => showScreen("home"));
  });

  document.querySelectorAll("#export-button, #settings-export-button")
    .forEach((button) => button.addEventListener("click", exportProgress));
  document.querySelectorAll("#import-button, #settings-import-button")
    .forEach((button) => button.addEventListener("click", () => elements.importFile.click()));
  elements.importFile.addEventListener("change", () => {
    const [file] = elements.importFile.files || [];
    if (file) {
      importProgress(file);
      renderHome();
      if (visibleScreen === "settings") renderSettings();
    }
  });

  document.querySelector("#add-cat-button").addEventListener("click", () => editCat(null));
  document.querySelector("#settings-add-cat-button").addEventListener("click", () => editCat(null));
  [document.querySelector("#home-companions"), document.querySelector("#settings-companions"),
    document.querySelector("#game-companions")].forEach((container) => {
    container.addEventListener("click", (event) => {
      const button = event.target.closest("[data-cat-action]");
      if (button) handleCatAction(button.dataset.catAction, button.dataset.catId);
    });
  });
  gameCompanionsToggle.addEventListener("click", () => {
    gameCompanionsExpanded = !gameCompanionsExpanded;
    renderGameCompanions();
  });
  compactLayout.addEventListener("change", (event) => {
    gameCompanionsExpanded = !event.matches;
    gameCompanionsList.hidden = event.matches;
    gameCompanionsToggle.setAttribute("aria-expanded", String(gameCompanionsExpanded));
  });
  document.querySelector("#cat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#cat-name").value.trim();
    if (!name) return;
    const isGray = document.querySelector("#cat-color").value === "gray";
    if (catBeingEdited) {
      const cat = state.settings.catBuddies.find((item) => item.id === catBeingEdited);
      if (cat) Object.assign(cat, { name, isGray });
    } else {
      state.settings.catBuddies.push({
        id: `cat-${Date.now()}-${randomInt(100000)}`,
        name,
        isGray,
        isSleeping: false
      });
    }
    catDialog.close();
    catBeingEdited = null;
    saveSettings();
    renderGameCompanions();
  });
  document.querySelector("#cat-cancel-button").addEventListener("click", () => catDialog.close());

  document.querySelector("#player-name").addEventListener("input", (event) => {
    state.settings.playerName = event.currentTarget.value.slice(0, 24);
    saveState();
    renderHome();
  });
  document.querySelector("#player-gender").addEventListener("change", (event) => {
    state.settings.playerGender = event.currentTarget.value;
    saveSettings();
  });
  document.querySelector("#theme-mode").addEventListener("change", (event) => {
    state.settings.themeMode = event.currentTarget.value;
    saveSettings();
  });
  document.querySelector("#color-palette").addEventListener("change", (event) => {
    state.settings.colorPalette = event.currentTarget.value;
    saveSettings();
  });
  document.querySelector("#music-enabled").addEventListener("change", (event) => {
    state.settings.musicEnabled = event.currentTarget.checked;
    saveSettings();
  });
  document.querySelector("#sounds-enabled").addEventListener("change", (event) => {
    state.settings.uiSoundsEnabled = event.currentTarget.checked;
    saveSettings();
  });
  document.querySelector("#music-volume").addEventListener("input", (event) => {
    const volume = Number(event.currentTarget.value) / 100;
    state.settings.musicVolume = volume;
    document.querySelector("#music-volume-value").value = `${Math.round(volume * 100)}%`;
    saveSettings();
  });
  document.querySelector("#sounds-volume").addEventListener("input", (event) => {
    const volume = Number(event.currentTarget.value) / 100;
    state.settings.uiVolume = volume;
    document.querySelector("#sounds-volume-value").value = `${Math.round(volume * 100)}%`;
    saveSettings();
  });

  document.querySelector("#victory-next-button").addEventListener("click", () => {
    victoryDialog.close();
    handleAction("next");
  });
  document.querySelector("#victory-home-button").addEventListener("click", () => {
    victoryDialog.close();
    showScreen("home");
  });
  if (typeof systemTheme.addEventListener === "function") {
    systemTheme.addEventListener("change", () => {
      if (state.settings.themeMode === "SYSTEM") applyTheme();
    });
  } else if (typeof systemTheme.addListener === "function") {
    systemTheme.addListener(() => {
      if (state.settings.themeMode === "SYSTEM") applyTheme();
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    elements.installButton.hidden = false;
  });

  elements.installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    elements.installButton.hidden = true;
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        elements.saveStatus.textContent = "Офлайн-кэш не включился";
        elements.saveStatus.title = error instanceof Error ? error.message : String(error);
      });
    });
  }

  renderHome();
  renderSettings();
  render();
  audio.updateSettings(state.settings);
  window.Mellowoku = Object.freeze({
    makeClassicGame,
    makeMeowGame,
    isValidSave,
    isMeowSolved,
    countSudokuSolutions,
    classicSize
  });
})();
