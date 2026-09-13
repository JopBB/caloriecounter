/* ============================================================
   Ledger — daily calorie tracker
   ------------------------------------------------------------
   Everything lives inside one IIFE (the `(function(){ ... })();`
   wrapper at the bottom) so none of these names leak into the
   global page.

   Roughly in order, this file contains:
     1.  Firebase configuration and connection
     2.  App state (which day you are viewing, target, weight unit)
     3.  Date helpers
     4.  Storage helpers (Firebase or local fallback)
     5.  Rendering: date navigation, total card, meal sections
     6.  Food search via Open Food Facts
     7.  Weight logging and history
     8.  Weight trend chart
     9.  Add / edit entry modal
     10. Sign in / sign out
     11. Startup
   ============================================================ */

(function () {
  /** Shorthand for document.getElementById. */
  const getElement = id => document.getElementById(id);

  // ============================================================
  // 1. FIREBASE CONFIG — paste your config object from the Firebase
  // console here (Project Settings > General > Your apps).
  // Until apiKey below is a real value, the app falls back to this
  // browser's local storage automatically — nothing breaks.
  // ============================================================
  const firebaseConfig = {
    apiKey: "AIzaSyDbei2WJEQ6aRd-Bdlkl88SptrlNEAoy4M",
    authDomain: "caloriecounter-6777f.firebaseapp.com",
    databaseURL: "https://caloriecounter-6777f-default-rtdb.europe-west1.firebasedatabase.app/",
    projectId: "caloriecounter-6777f",
  };

  // Both stay null when Firebase is not configured or fails to start. In that
  // case the app skips the sign-in screen and keeps everything in this
  // browser's local storage instead — every storage helper below checks.
  let firebaseDatabase = null;
  let firebaseAuth = null;

  const firebaseIsConfigured =
    firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY" &&
    firebaseConfig.databaseURL && firebaseConfig.databaseURL !== "PASTE_DATABASE_URL_HERE";

  if (firebaseIsConfigured) {
    try {
      firebase.initializeApp(firebaseConfig);
      firebaseDatabase = firebase.database();
      firebaseAuth = firebase.auth();
    } catch (error) {
      console.error('Firebase init failed, falling back to local storage.', error);
      firebaseDatabase = null;
      firebaseAuth = null;
    }
  }

  /** Read a value from Firebase; resolves to null if the read fails. */
  function readFromFirebase(path) {
    return new Promise(resolve => {
      firebaseDatabase.ref(path).once(
        'value',
        snapshot => resolve(snapshot.val()),
        () => resolve(null)
      );
    });
  }

  /** Write a value to Firebase. Passing null deletes the path. */
  function writeToFirebase(path, value) {
    return firebaseDatabase.ref(path).set(value);
  }

  // ============================================================
  // 2. APP STATE
  // ============================================================

  /** The day currently shown, as a "YYYY-MM-DD" string. */
  let selectedDate = getTodayKey();

  /** Daily calorie goal, or null when the user has not set one. */
  let dailyCalorieTarget = null;

  /**
   * Favourites for every meal, refreshed by refreshLog. Cached because both the
   * log rows (to draw the star) and the modal (to list them) need it, and
   * neither wants to await a read mid-render.
   */
  let favoritesByMeal = {};

  // ============================================================
  // 3. DATE HELPERS
  // Dates are stored and compared as plain "YYYY-MM-DD" strings.
  // ============================================================

  /** Turn a Date object into a "YYYY-MM-DD" key. */
  function formatDateKey(date) {
    return date.toISOString().slice(0, 10);
  }

  /** Today as a "YYYY-MM-DD" key. */
  function getTodayKey() {
    return formatDateKey(new Date());
  }

  /** Move a date key forward (positive) or backward (negative) by whole days. */
  function shiftDateKey(dateKey, dayOffset) {
    const date = new Date(dateKey + 'T00:00:00');
    date.setDate(date.getDate() + dayOffset);
    return formatDateKey(date);
  }

  /** Human-friendly label for a date key: "Today", "Yesterday" or e.g. "Mon, Sep 8". */
  function formatDateLabel(dateKey) {
    if (dateKey === getTodayKey()) return 'Today';
    if (dateKey === shiftDateKey(getTodayKey(), -1)) return 'Yesterday';
    const date = new Date(dateKey + 'T00:00:00');
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // ============================================================
  // 4. STORAGE HELPERS
  // Data shape stays identical either way: loadLogForDate returns an
  // array of entries, loadWeights returns an array of weight records,
  // loadSettings returns a plain object. Only the underlying store changes.
  //
  // The fallback store is this browser's localStorage, which is per-device
  // and never synced. It is only reached when Firebase is absent or fails.
  // ============================================================

  /** Prefix for the localStorage key holding one day's food log. */
  const LOCAL_LOG_PREFIX = 'log:';

  /** Read and parse a localStorage value; returns fallbackValue if absent or corrupt. */
  function readLocal(key, fallbackValue) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallbackValue : JSON.parse(raw);
    } catch (error) {
      return fallbackValue;
    }
  }

  /** Write a value to localStorage as JSON. */
  function writeLocal(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error('save to local storage failed', error);
    }
  }

  /** All food entries logged on one day. */
  async function loadLogForDate(dateKey) {
    if (firebaseDatabase) {
      const stored = await readFromFirebase('logs/' + dateKey);
      return stored ? Object.values(stored) : [];
    }
    return readLocal(LOCAL_LOG_PREFIX + dateKey, []);
  }

  /** Replace the whole food log for one day. */
  async function saveLogForDate(dateKey, entries) {
    if (firebaseDatabase) {
      const entriesById = {};
      entries.forEach(entry => { entriesById[entry.id] = entry; });
      await writeToFirebase('logs/' + dateKey, entries.length ? entriesById : null);
      return;
    }
    writeLocal(LOCAL_LOG_PREFIX + dateKey, entries);
  }

  /** Every weigh-in ever recorded. */
  async function loadWeights() {
    if (firebaseDatabase) {
      const stored = await readFromFirebase('weights');
      return stored ? Object.values(stored) : [];
    }
    return readLocal('weights', []);
  }

  /** Replace the whole list of weigh-ins. */
  async function saveWeights(weighIns) {
    if (firebaseDatabase) {
      const weighInsByTimestamp = {};
      weighIns.forEach(weighIn => { weighInsByTimestamp[weighIn.ts] = weighIn; });
      await writeToFirebase('weights', weighIns.length ? weighInsByTimestamp : null);
      return;
    }
    writeLocal('weights', weighIns);
  }

  /**
   * Saved favourites, as { breakfast: [...], lunch: [...], ... }. Each entry is
   * a template: { id, name, calories } plus { grams, caloriesPer100g } when the
   * favourite came from a product with a per-100g rate.
   *
   * This is data, not view state, so it goes through the helpers and syncs.
   */
  async function loadFavorites() {
    if (firebaseDatabase) {
      const stored = await readFromFirebase('favorites');
      return stored || {};
    }
    return readLocal('favorites', {});
  }

  /** Replace the whole favourites object. */
  async function saveFavorites(favoritesByMeal) {
    if (firebaseDatabase) {
      await writeToFirebase('favorites', favoritesByMeal);
      return;
    }
    writeLocal('favorites', favoritesByMeal);
  }

  /** User settings — currently just { dailyTarget }. */
  async function loadSettings() {
    if (firebaseDatabase) {
      const stored = await readFromFirebase('settings');
      return stored || {};
    }
    return readLocal('settings', {});
  }

  /** Replace the settings object. */
  async function saveSettings(settings) {
    if (firebaseDatabase) {
      await writeToFirebase('settings', settings);
      return;
    }
    writeLocal('settings', settings);
  }

  /** Escape text so it is safe to drop into innerHTML. */
  function escapeHtml(text) {
    const holder = document.createElement('div');
    holder.textContent = text;
    return holder.innerHTML;
  }

  // ============================================================
  // 5a. RENDER: HEADER / DATE NAVIGATION
  // ============================================================

  function renderDateNav() {
    getElement('dateLabel').textContent = formatDateLabel(selectedDate);
    getElement('jumpToday').style.display = selectedDate === getTodayKey() ? 'none' : 'inline';
  }

  getElement('prevDay').addEventListener('click', () => {
    selectedDate = shiftDateKey(selectedDate, -1);
    refreshLog();
  });
  getElement('nextDay').addEventListener('click', () => {
    selectedDate = shiftDateKey(selectedDate, 1);
    refreshLog();
  });
  getElement('jumpToday').addEventListener('click', () => {
    selectedDate = getTodayKey();
    refreshLog();
  });

  // ============================================================
  // 5b. RENDER: TOTAL CARD AND DAILY TARGET
  // ============================================================

  function renderTotal(entries) {
    const totalCalories = entries.reduce((sum, entry) => sum + (Number(entry.calories) || 0), 0);
    getElement('totalNum').textContent = totalCalories;
    getElement('totalUnit').textContent =
      selectedDate === getTodayKey() ? 'kcal today' : 'kcal that day';

    const progressBar = getElement('progressBar');
    const totalNumber = getElement('totalNum');

    if (dailyCalorieTarget && dailyCalorieTarget > 0) {
      const percentOfTarget = Math.min(100, (totalCalories / dailyCalorieTarget) * 100);
      progressBar.style.width = percentOfTarget + '%';

      const caloriesRemaining = dailyCalorieTarget - totalCalories;
      if (caloriesRemaining >= 0) {
        getElement('remainingLabel').textContent =
          caloriesRemaining + ' kcal left of ' + dailyCalorieTarget;
        progressBar.classList.remove('over');
        totalNumber.classList.remove('over');
      } else {
        getElement('remainingLabel').textContent =
          Math.abs(caloriesRemaining) + ' kcal over ' + dailyCalorieTarget;
        progressBar.classList.add('over');
        totalNumber.classList.add('over');
      }
    } else {
      progressBar.style.width = '0%';
      getElement('remainingLabel').textContent = 'Set a daily target to see what\'s left';
      progressBar.classList.remove('over');
      totalNumber.classList.remove('over');
    }
  }

  getElement('editTargetBtn').addEventListener('click', async () => {
    const answer = prompt('Daily calorie target (kcal):', dailyCalorieTarget || '');
    if (answer === null) return;

    const target = parseInt(answer, 10);
    if (!isNaN(target) && target > 0) {
      dailyCalorieTarget = target;
      await saveSettings({ dailyTarget: target });
      const entries = await loadLogForDate(selectedDate);
      renderTotal(entries);
    }
  });

  // ============================================================
  // 5c. RENDER: FOOD ENTRY LIST
  // ============================================================

  /**
   * The four meals, in render order. Everything downstream — the sections, the
   * modal's picker, the stored `meal` value — is driven off this list, so the
   * names are spelled out exactly once.
   */
  const MEALS = [
    { key: 'breakfast', label: 'Breakfast' },
    { key: 'lunch',     label: 'Lunch' },
    { key: 'dinner',    label: 'Dinner' },
    { key: 'snacks',    label: 'Snacks' },
  ];

  // Boundaries for the time-of-day default, as whole hours on a 24h clock.
  const BREAKFAST_ENDS_HOUR = 11;  // before 11:00 → breakfast
  const LUNCH_ENDS_HOUR     = 15;  // 11:00–14:59 → lunch
  const DINNER_ENDS_HOUR    = 21;  // 15:00–20:59 → dinner
                                   // 21:00 and later → snacks

  /**
   * Which meal a new entry defaults to, from the current clock time — not from
   * the day being viewed. Logging Tuesday's dinner on Thursday morning still
   * defaults to breakfast; the picker is one tap away.
   */
  function mealForNow() {
    const hour = new Date().getHours();
    if (hour < BREAKFAST_ENDS_HOUR) return 'breakfast';
    if (hour < LUNCH_ENDS_HOUR) return 'lunch';
    if (hour < DINNER_ENDS_HOUR) return 'dinner';
    return 'snacks';
  }

  /**
   * Which section an entry renders under. Entries written before meals existed
   * have no `meal`, and fall back to snacks — at render time only. Nothing is
   * rewritten in storage until the user edits the entry themselves.
   */
  function mealKeyForEntry(entry) {
    const isKnownMeal = MEALS.some(meal => meal.key === entry.meal);
    return isKnownMeal ? entry.meal : 'snacks';
  }

  /**
   * Which sections are folded, as { breakfast: true, ... }.
   *
   * Deliberately bypasses the storage helpers and talks to localStorage
   * directly. Whether a section is folded is per-device view state, not data:
   * syncing it through Firebase would let a phone's folded sections fold the
   * laptop's, and would write to the log on a UI tap. Nothing else may do this.
   */
  const COLLAPSED_MEALS_KEY = 'ledger.collapsedMeals';

  function loadCollapsedMeals() {
    try {
      const parsed = JSON.parse(localStorage.getItem(COLLAPSED_MEALS_KEY));
      // Anything unexpected in there means "all expanded" rather than a crash.
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function saveCollapsedMeals(collapsedMeals) {
    try {
      localStorage.setItem(COLLAPSED_MEALS_KEY, JSON.stringify(collapsedMeals));
    } catch (error) {
      // View state only — losing it is not worth interrupting the user for.
    }
  }

  /**
   * Favourites are matched by name within a meal, case- and space-insensitive,
   * so starring the same thing twice updates rather than duplicates.
   */
  function favoriteKeyFor(name) {
    return String(name || '').trim().toLowerCase();
  }

  /** That meal's favourites, always an array. */
  function favoritesForMeal(mealKey) {
    const list = favoritesByMeal[mealKey];
    return Array.isArray(list) ? list : [];
  }

  function findFavorite(mealKey, name) {
    const key = favoriteKeyFor(name);
    return favoritesForMeal(mealKey).find(favorite => favoriteKeyFor(favorite.name) === key) || null;
  }

  /**
   * Star or unstar an entry for its meal. Favourites store the whole template —
   * including the per-100g rate when there is one — so re-adding reproduces the
   * entry exactly rather than just its name.
   */
  async function toggleFavorite(entry) {
    const mealKey = mealKeyForEntry(entry);
    const key = favoriteKeyFor(entry.name);
    const remaining = favoritesForMeal(mealKey)
      .filter(favorite => favoriteKeyFor(favorite.name) !== key);

    if (remaining.length === favoritesForMeal(mealKey).length) {
      // Was not starred — add it.
      const favorite = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        name: entry.name || 'Untitled',
        calories: Number(entry.calories) || 0,
      };
      if (typeof entry.caloriesPer100g === 'number') {
        favorite.grams = entry.grams;
        favorite.caloriesPer100g = entry.caloriesPer100g;
      }
      remaining.push(favorite);
    }

    favoritesByMeal[mealKey] = remaining;
    await saveFavorites(favoritesByMeal);
    refreshLog();
  }

  /** One row in the log: name, optional amount, calories, star, delete. */
  function buildEntryRow(entry) {
    const isStarred = !!findFavorite(mealKeyForEntry(entry), entry.name);
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML =
      '<span class="ename">' +
        '<span class="etext">' + escapeHtml(entry.name || 'Untitled') + '</span>' +
        (entry.grams != null
          ? '<span class="eamount">' + entry.grams + ' g</span>'
          : '') +
      '</span>' +
      '<span class="eright">' +
        '<span class="ecal">' + Math.round(entry.calories) + ' kcal</span>' +
        '<button class="efav' + (isStarred ? ' on' : '') + '"' +
          ' aria-pressed="' + isStarred + '"' +
          ' aria-label="' + (isStarred ? 'Remove from favourites' : 'Add to favourites') + '">' +
          (isStarred ? '\u2605' : '\u2606') +
        '</button>' +
        '<button class="edel" aria-label="Delete entry">×</button>' +
      '</span>';

    // Clicking anywhere else on the row opens it for editing.
    row.addEventListener('click', () => {
      openEntryModal({
        entryId: entry.id,
        name: entry.name || '',
        calories: entry.calories,
        grams: entry.grams,
        caloriesPer100g: entry.caloriesPer100g,
        meal: mealKeyForEntry(entry),
      });
    });

    row.querySelector('.efav').addEventListener('click', async event => {
      event.stopPropagation();
      await toggleFavorite(entry);
    });

    row.querySelector('.edel').addEventListener('click', async event => {
      // Without this the row's own click handler would open the modal too.
      event.stopPropagation();
      // Re-read before deleting so we do not overwrite changes made elsewhere.
      const latestEntries = await loadLogForDate(selectedDate);
      const index = latestEntries.findIndex(candidate => candidate.id === entry.id);
      if (index > -1) {
        latestEntries.splice(index, 1);
        await saveLogForDate(selectedDate, latestEntries);
        refreshLog();
      }
    });

    return row;
  }

  /**
   * Draw the log as four fixed meal sections. All four always render, empty or
   * not — a section list that changes shape as you log is not scannable.
   */
  function renderEntries(entries) {
    const list = getElement('entryList');
    const collapsedMeals = loadCollapsedMeals();

    // Bucket by meal, keeping each section's entries in the order they arrived.
    const entriesByMeal = {};
    MEALS.forEach(meal => { entriesByMeal[meal.key] = []; });
    entries.forEach(entry => { entriesByMeal[mealKeyForEntry(entry)].push(entry); });

    list.innerHTML = '';

    // Accumulated from the rounded section totals rather than from `entries`,
    // so the four numbers on screen visibly add up to the one underneath them.
    let grandTotal = 0;

    MEALS.forEach(meal => {
      const mealEntries = entriesByMeal[meal.key];
      const mealTotal = mealEntries.reduce(
        (sum, entry) => sum + (Number(entry.calories) || 0), 0);
      grandTotal += Math.round(mealTotal);
      const isCollapsed = collapsedMeals[meal.key] === true;
      const rowsId = 'mealRows-' + meal.key;

      const section = document.createElement('div');
      section.className = 'meal-section' + (isCollapsed ? ' collapsed' : '');

      // The fold toggle and the add button are siblings rather than nested —
      // a button inside a button is invalid and behaves unpredictably.
      const headerRow = document.createElement('div');
      headerRow.className = 'meal-header-row';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'meal-header';
      header.setAttribute('aria-expanded', String(!isCollapsed));
      header.setAttribute('aria-controls', rowsId);
      header.innerHTML =
        '<span class="meal-caret" aria-hidden="true"></span>' +
        '<span class="meal-name">' + meal.label + '</span>' +
        '<span class="meal-total">' + Math.round(mealTotal) + ' kcal</span>';

      // Opens the entry modal in calorie mode, already pointed at this meal.
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.className = 'meal-add';
      addButton.textContent = '+';
      addButton.setAttribute('aria-label', 'Add to ' + meal.label);
      addButton.addEventListener('click', () => {
        openEntryModal({ meal: meal.key, showFavorites: true });
      });

      const rowsBox = document.createElement('div');
      rowsBox.className = 'meal-rows';
      rowsBox.id = rowsId;

      if (!mealEntries.length) {
        rowsBox.innerHTML = '<div class="empty">Nothing yet</div>';
      } else {
        mealEntries.forEach(entry => rowsBox.appendChild(buildEntryRow(entry)));
      }

      // Folding is pure view state: toggle a class, record it, and stop. No
      // re-read, so it stays instant with a slow or unreachable database.
      header.addEventListener('click', () => {
        const nowCollapsed = !section.classList.contains('collapsed');
        section.classList.toggle('collapsed', nowCollapsed);
        header.setAttribute('aria-expanded', String(!nowCollapsed));
        const latestCollapsed = loadCollapsedMeals();
        latestCollapsed[meal.key] = nowCollapsed;
        saveCollapsedMeals(latestCollapsed);
      });

      headerRow.appendChild(header);
      headerRow.appendChild(addButton);
      section.appendChild(headerRow);
      section.appendChild(rowsBox);
      list.appendChild(section);
    });

    // Closing row under the four sections. Folding a section does not change
    // it — a collapsed meal still counts towards the day.
    const grandTotalRow = document.createElement('div');
    grandTotalRow.className = 'meal-grand-total';
    grandTotalRow.innerHTML =
      '<span class="grand-label">Total</span>' +
      '<span class="grand-value">' + grandTotal + ' kcal</span>';
    list.appendChild(grandTotalRow);
  }

  /** Reload the selected day and redraw the header, total and entry list. */
  async function refreshLog() {
    renderDateNav();
    const [entries, favorites] = await Promise.all([
      loadLogForDate(selectedDate),
      loadFavorites(),
    ]);
    favoritesByMeal = favorites;
    renderTotal(entries);
    renderEntries(entries);
  }

  /**
   * Append one food entry to the selected day.
   *
   * `meal` has no default on purpose — every call site states which meal it is
   * writing, so a path that forgets fails visibly instead of quietly piling
   * everything into Snacks.
   *
   * `extraFields` carries the optional { grams, caloriesPer100g } pair for
   * entries added from search. Leave it out for hand-typed entries, which have
   * no rate to scale from. Never pass undefined values through — Firebase
   * rejects them.
   */
  async function addEntry(name, calories, meal, extraFields) {
    const entries = await loadLogForDate(selectedDate);
    entries.push(Object.assign({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name: name,
      calories: calories,
      ts: Date.now(),
      meal: meal,
    }, extraFields || {}));
    await saveLogForDate(selectedDate, entries);
    refreshLog();
  }

  // ============================================================
  // 6. FOOD SEARCH (Open Food Facts)
  // ============================================================

  /** Milliseconds to wait after typing stops before firing a search. */
  const SEARCH_DEBOUNCE_MS = 450;

  /** Do not search until the query is at least this long. */
  const MIN_SEARCH_LENGTH = 2;

  /** How many search results to request and show. */
  const MAX_SEARCH_RESULTS = 15;

  let searchDebounceTimer = null;

  getElement('searchInput').addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const query = getElement('searchInput').value.trim();

    if (query.length < MIN_SEARCH_LENGTH) {
      getElement('searchResults').style.display = 'none';
      getElement('searchMeta').textContent = '';
      return;
    }

    searchDebounceTimer = setTimeout(() => searchFoods(query), SEARCH_DEBOUNCE_MS);
  });

  async function searchFoods(query) {
    getElement('searchMeta').textContent = 'Searching…';
    getElement('searchResults').style.display = 'none';

    try {
      const url = 'https://world.openfoodfacts.org/cgi/search.pl?search_terms=' +
        encodeURIComponent(query) +
        '&search_simple=1&action=process&json=1&page_size=' + MAX_SEARCH_RESULTS +
        '&fields=product_name,brands,nutriments';

      const response = await fetch(url);
      const data = await response.json();

      // Keep only products we can actually show a calorie number for.
      const products = (data.products || []).filter(product =>
        product.product_name &&
        product.nutriments &&
        (product.nutriments['energy-kcal_100g'] || product.nutriments['energy-kcal_serving'])
      );

      renderSearchResults(products, query);
    } catch (error) {
      getElement('searchMeta').textContent = 'Search failed — check your connection and try again.';
    }
  }

  function renderSearchResults(products, query) {
    const resultsBox = getElement('searchResults');

    if (!products.length) {
      resultsBox.style.display = 'none';
      getElement('searchMeta').textContent =
        'No matches for "' + query + '". Try a shorter or more generic term, or add it with + on a meal.';
      return;
    }

    getElement('searchMeta').textContent =
      products.length + ' result' + (products.length === 1 ? '' : 's') +
      ' · per 100g shown, tap to add';

    resultsBox.innerHTML = '';
    products.slice(0, MAX_SEARCH_RESULTS).forEach(product => {
      const caloriesPer100g = product.nutriments['energy-kcal_100g'];
      const caloriesPerServing = product.nutriments['energy-kcal_serving'];

      // Prefer the per-100g figure; fall back to the per-serving one.
      const shownCalories = caloriesPer100g != null
        ? Math.round(caloriesPer100g)
        : Math.round(caloriesPerServing);
      const caloriesLabel = caloriesPer100g != null
        ? shownCalories + ' kcal/100g'
        : shownCalories + ' kcal/serving';

      const row = document.createElement('div');
      row.className = 'result-row';
      row.innerHTML =
        '<span class="rname">' + escapeHtml(product.product_name) +
          (product.brands
            ? '<span class="brand">' + escapeHtml(product.brands.split(',')[0]) + '</span>'
            : '') +
        '</span>' +
        '<span class="rcal">' + caloriesLabel + '</span>' +
        '<button>add</button>';

      row.querySelector('button').addEventListener('click', () => {
        // With a per-100g figure the modal opens in gram mode and scales from
        // the rate. With only a per-serving figure there is nothing to scale,
        // so it opens in calorie mode pre-filled with one serving.
        openEntryModal({
          name: product.product_name,
          caloriesPer100g: caloriesPer100g != null ? caloriesPer100g : null,
          grams: caloriesPer100g != null ? DEFAULT_GRAMS : null,
          calories: caloriesPer100g != null ? null : shownCalories,
          // Only clear the search once something is actually saved, so that
          // cancelling leaves the results up to pick from again.
          onSaved: () => {
            getElement('searchInput').value = '';
            resultsBox.style.display = 'none';
            getElement('searchMeta').textContent = '';
          },
        });
      });

      resultsBox.appendChild(row);
    });

    resultsBox.style.display = 'block';
  }

  // ============================================================
  // 7. WEIGHT
  // ============================================================

  /** How many recent weigh-ins the history list shows. */
  const WEIGHT_HISTORY_LIMIT = 20;

  /** Differences smaller than this, in kg, are not shown. */
  const MIN_SHOWN_WEIGHT_DELTA = 0.05;

  /**
   * Read a decimal the user typed, accepting either separator.
   *
   * The field is a text input rather than type=number on purpose: a number
   * input hands back an empty string for anything the browser considers
   * malformed, which in some locales includes "88.3". Parsing it ourselves
   * means a period always works, and a comma does too.
   *
   * Returns null when there is no usable number.
   */
  function parseDecimalInput(text) {
    const normalised = String(text).trim().replace(/\s/g, '').replace(',', '.');
    if (!/^\d*\.?\d+$/.test(normalised)) return null;
    const value = parseFloat(normalised);
    return Number.isFinite(value) ? value : null;
  }

  getElement('addWeightBtn').addEventListener('click', addWeight);
  getElement('weightInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') addWeight();
  });

  async function addWeight() {
    const kilograms = parseDecimalInput(getElement('weightInput').value);
    if (kilograms === null || kilograms <= 0) return;

    const weighIns = await loadWeights();
    weighIns.push({ date: getTodayKey(), kg: kilograms, ts: Date.now() });
    weighIns.sort((a, b) => a.ts - b.ts);
    await saveWeights(weighIns);

    getElement('weightInput').value = '';
    renderWeightHistory();
  }

  async function renderWeightHistory() {
    const weighIns = await loadWeights();
    renderWeightChart(weighIns);

    const historyBox = getElement('weightHistory');
    if (!weighIns.length) {
      historyBox.innerHTML = '<div class="empty">No weight logged yet.</div>';
      return;
    }

    // Newest first, capped at WEIGHT_HISTORY_LIMIT rows.
    const newestFirst = [...weighIns]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, WEIGHT_HISTORY_LIMIT);

    historyBox.innerHTML = '';
    newestFirst.forEach((weighIn, index) => {
      const displayValue = weighIn.kg;

      // The next row down is the previous weigh-in, so we can show the change.
      const previousWeighIn = newestFirst[index + 1];
      let deltaHtml = '';
      if (previousWeighIn) {
        const displayDelta = weighIn.kg - previousWeighIn.kg;
        if (Math.abs(displayDelta) >= MIN_SHOWN_WEIGHT_DELTA) {
          const directionClass = displayDelta < 0 ? 'down' : 'up';
          const sign = displayDelta > 0 ? '+' : '';
          deltaHtml =
            '<span class="weight-delta ' + directionClass + '">' +
            sign + displayDelta.toFixed(1) +
            '</span>';
        }
      }

      const row = document.createElement('div');
      row.className = 'weight-entry';
      row.innerHTML =
        '<span class="wdate">' + formatDateLabel(weighIn.date) + '</span>' +
        '<span class="wval">' + deltaHtml +
          '<span>' + displayValue.toFixed(1) + ' kg</span>' +
          '<button class="wdel" aria-label="Delete weight entry">×</button>' +
        '</span>';

      row.querySelector('.wdel').addEventListener('click', async () => {
        const latestWeighIns = await loadWeights();
        const index = latestWeighIns.findIndex(candidate => candidate.ts === weighIn.ts);
        if (index > -1) {
          latestWeighIns.splice(index, 1);
          await saveWeights(latestWeighIns);
          renderWeightHistory();
        }
      });

      historyBox.appendChild(row);
    });
  }

  // ============================================================
  // 8. WEIGHT CHART (plain inline SVG, no library)
  // ============================================================

  /** How many of the most recent weigh-ins the chart plots. */
  const CHART_POINT_LIMIT = 30;

  // The SVG is drawn in these coordinates and then scaled to fit the box.
  const CHART_WIDTH = 600;
  const CHART_HEIGHT = 160;
  const CHART_PADDING_LEFT = 34;   // room for the value labels
  const CHART_PADDING_RIGHT = 10;
  const CHART_PADDING_TOP = 12;
  const CHART_PADDING_BOTTOM = 22; // room for the date labels

  /** Extra head- and foot-room above and below the line, as a share of its range. */
  const CHART_VERTICAL_MARGIN_RATIO = 0.12;

  function renderWeightChart(weighIns) {
    const chartBox = getElement('chartBox');

    if (!weighIns.length) {
      chartBox.innerHTML =
        '<div class="chart-empty">Log a couple of weigh-ins to see a trend line here.</div>';
      return;
    }

    const oldestFirst = [...weighIns]
      .sort((a, b) => a.ts - b.ts)
      .slice(-CHART_POINT_LIMIT);
    const displayValues = oldestFirst.map(weighIn => weighIn.kg);

    const plotWidth = CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
    const plotHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;

    // Work out the value range the y-axis has to cover.
    let minValue = Math.min(...displayValues);
    let maxValue = Math.max(...displayValues);
    if (minValue === maxValue) { minValue -= 1; maxValue += 1; } // flat line: invent a range
    const verticalMargin = (maxValue - minValue) * CHART_VERTICAL_MARGIN_RATIO;
    minValue -= verticalMargin;
    maxValue += verticalMargin;

    /** Horizontal position of the point at `index`. */
    const xForIndex = index => oldestFirst.length === 1
      ? CHART_PADDING_LEFT + plotWidth / 2
      : CHART_PADDING_LEFT + (index / (oldestFirst.length - 1)) * plotWidth;

    /** Vertical position of a weight value (SVG y grows downwards). */
    const yForValue = value =>
      CHART_PADDING_TOP + plotHeight - ((value - minValue) / (maxValue - minValue)) * plotHeight;

    let linePath = '';
    oldestFirst.forEach((weighIn, index) => {
      const x = xForIndex(index);
      const y = yForValue(displayValues[index]);
      linePath += (index === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    });

    let dotsMarkup = '';
    oldestFirst.forEach((weighIn, index) => {
      dotsMarkup +=
        '<circle class="chart-pt" cx="' + xForIndex(index).toFixed(1) +
        '" cy="' + yForValue(displayValues[index]).toFixed(1) + '" r="3"></circle>';
    });

    // A handful of x-axis date labels (first, middle, last).
    let dateLabelsMarkup = '';
    const labelIndexes = oldestFirst.length > 1
      ? [0, Math.floor((oldestFirst.length - 1) / 2), oldestFirst.length - 1]
      : [0];
    [...new Set(labelIndexes)].forEach(index => {
      const date = new Date(oldestFirst[index].date + 'T00:00:00');
      const labelText = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      dateLabelsMarkup +=
        '<text class="chart-axis-label" x="' + xForIndex(index).toFixed(1) +
        '" y="' + (CHART_HEIGHT - 6) + '" text-anchor="middle">' + labelText + '</text>';
    });

    chartBox.innerHTML =
      '<svg viewBox="0 0 ' + CHART_WIDTH + ' ' + CHART_HEIGHT + '" preserveAspectRatio="none">' +
        '<text class="chart-axis-label" x="' + (CHART_PADDING_LEFT - 4) +
          '" y="' + (CHART_PADDING_TOP + 4) + '" text-anchor="end">' + maxValue.toFixed(1) + '</text>' +
        '<text class="chart-axis-label" x="' + (CHART_PADDING_LEFT - 4) +
          '" y="' + (CHART_PADDING_TOP + plotHeight) + '" text-anchor="end">' + minValue.toFixed(1) + '</text>' +
        '<path class="chart-line" d="' + linePath.trim() + '"></path>' +
        dotsMarkup +
        dateLabelsMarkup +
      '</svg>';
  }

  // ============================================================
  // 9. ADD / EDIT ENTRY MODAL
  //
  // One modal serves two modes:
  //
  //   'grams'    — the entry knows its per-100g rate, so the amount is what you
  //                edit and the calories are derived and shown live.
  //   'calories' — no rate is known (entries typed via + on a meal, products
  //                that only reported a per-serving figure), so you type them.
  //
  // Invariant for gram-mode entries:
  //   calories === Math.round(caloriesPer100g * grams / 100)
  // `calories` is always stored, so everything that reads entries — the daily
  // total, the list — keeps working without knowing about the other two fields.
  // ============================================================

  /** Amount pre-filled when adding a product from search. */
  const DEFAULT_GRAMS = 100;

  /**
   * What the modal is currently editing, or null when it is closed.
   * { mode, entryId, caloriesPer100g, meal, onSaved }
   * entryId is null when adding rather than editing.
   */
  let entryModalContext = null;

  // The picker is built once from MEALS and then just has its active button
  // moved, rather than being rebuilt on every open.
  MEALS.forEach(meal => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = meal.label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => setEntryModalMeal(meal.key));
    getElement('mealPicker').appendChild(button);
  });

  /** Select a meal in the picker, moving the active state and aria-pressed. */
  function setEntryModalMeal(mealKey) {
    if (entryModalContext) entryModalContext.meal = mealKey;
    const buttons = getElement('mealPicker').children;
    MEALS.forEach((meal, index) => {
      const isSelected = meal.key === mealKey;
      buttons[index].classList.toggle('active', isSelected);
      buttons[index].setAttribute('aria-pressed', String(isSelected));
    });
    // Favourites are per meal, so switching meal switches the list too.
    renderModalFavorites(mealKey);
  }

  /**
   * Draw the favourites shortcut list for one meal inside the modal.
   * Pick-only: unstarring happens on the log row, not here.
   */
  function renderModalFavorites(mealKey) {
    const field = getElement('favoritesField');
    const list = getElement('favoritesList');
    const favorites = favoritesForMeal(mealKey);

    // Hidden entirely when editing, when opened from search, or when this meal
    // has nothing starred yet — an empty heading would just be noise.
    if (!entryModalContext || !entryModalContext.showFavorites || !favorites.length) {
      field.hidden = true;
      list.innerHTML = '';
      return;
    }

    field.hidden = false;
    list.innerHTML = '';
    favorites.forEach(favorite => {
      const row = document.createElement('div');
      row.className = 'favorite-row';
      row.innerHTML =
        '<button class="favorite-pick" type="button">' +
          '<span class="favorite-name">' + escapeHtml(favorite.name) + '</span>' +
          '<span class="favorite-cal">' + Math.round(favorite.calories) + ' kcal' +
            (favorite.grams != null ? ' · ' + favorite.grams + ' g' : '') +
          '</span>' +
        '</button>';

      row.querySelector('.favorite-pick').addEventListener('click', () => {
        applyFavoriteToModal(favorite);
      });

      list.appendChild(row);
    });
  }

  /**
   * Fill the modal from a favourite. Switches the modal between gram and
   * calorie mode, since a favourite made from a searched product carries a
   * per-100g rate and one typed by hand does not.
   */
  function applyFavoriteToModal(favorite) {
    if (!entryModalContext) return;
    const isGramMode = typeof favorite.caloriesPer100g === 'number';

    entryModalContext.mode = isGramMode ? 'grams' : 'calories';
    entryModalContext.caloriesPer100g = isGramMode ? favorite.caloriesPer100g : null;

    getElement('entryName').value = favorite.name;
    getElement('gramFields').hidden = !isGramMode;
    getElement('calorieFields').hidden = isGramMode;

    if (isGramMode) {
      getElement('entryGrams').value = favorite.grams != null ? favorite.grams : DEFAULT_GRAMS;
    } else {
      getElement('entryCalories').value = Math.round(favorite.calories);
    }

    updateEntryModalPreview();
  }

  /**
   * Open the modal.
   *
   * Passing a numeric `caloriesPer100g` selects gram mode; anything else
   * selects calorie mode. Pass `entryId` to edit an existing entry, or leave
   * it out to add a new one.
   */
  function openEntryModal(options) {
    const isGramMode = typeof options.caloriesPer100g === 'number';

    entryModalContext = {
      mode: isGramMode ? 'grams' : 'calories',
      entryId: options.entryId || null,
      caloriesPer100g: isGramMode ? options.caloriesPer100g : null,
      meal: null,
      // Favourites are a shortcut for hand-adding, so they are offered from a
      // meal's + button only — not when editing, and not after a search hit.
      showFavorites: !options.entryId && !!options.showFavorites,
      onSaved: options.onSaved || null,
    };

    getElement('entryModalTitle').textContent = options.entryId ? 'Edit entry' : 'Add food';
    getElement('entryName').value = options.name || '';
    // Editing keeps the entry's own meal; adding opens on the time-of-day default.
    // setEntryModalMeal also draws the favourites list for the chosen meal.
    setEntryModalMeal(options.meal || mealForNow());
    getElement('gramFields').hidden = !isGramMode;
    getElement('calorieFields').hidden = isGramMode;

    if (isGramMode) {
      getElement('entryGrams').value = options.grams != null ? options.grams : DEFAULT_GRAMS;
    } else {
      getElement('entryCalories').value = options.calories != null ? options.calories : '';
    }

    getElement('entryModal').style.display = 'flex';
    updateEntryModalPreview();

    // Land on the field you are most likely to change.
    const fieldToFocus = isGramMode ? getElement('entryGrams') : getElement('entryName');
    fieldToFocus.focus();
    fieldToFocus.select();
  }

  function closeEntryModal() {
    getElement('entryModal').style.display = 'none';
    entryModalContext = null;
    // Reset so the next open cannot inherit anything from this one.
    getElement('entryName').value = '';
    getElement('entryGrams').value = '';
    getElement('entryCalories').value = '';
    getElement('caloriePreview').textContent = '—';
  }

  /**
   * The calorie figure the modal would save right now, or null when the input
   * is empty, zero or not a number.
   */
  function computeEntryModalCalories() {
    if (!entryModalContext) return null;

    if (entryModalContext.mode === 'grams') {
      const grams = parseFloat(getElement('entryGrams').value);
      if (isNaN(grams) || grams <= 0) return null;
      return Math.round((entryModalContext.caloriesPer100g * grams) / 100);
    }

    const calories = parseFloat(getElement('entryCalories').value);
    if (isNaN(calories) || calories <= 0) return null;
    return Math.round(calories);
  }

  /** Refresh the live readout and enable or disable Save. */
  function updateEntryModalPreview() {
    const calories = computeEntryModalCalories();

    if (entryModalContext && entryModalContext.mode === 'grams') {
      getElement('caloriePreview').textContent =
        calories === null ? '—' : '≈ ' + calories + ' kcal';
    }

    getElement('entrySaveBtn').disabled = calories === null;
  }

  getElement('entryGrams').addEventListener('input', updateEntryModalPreview);
  getElement('entryCalories').addEventListener('input', updateEntryModalPreview);

  async function saveEntryModal() {
    const calories = computeEntryModalCalories();
    if (calories === null || !entryModalContext) return;

    const context = entryModalContext;
    const name = getElement('entryName').value.trim();

    // Only gram-mode entries carry these two; leaving them off calorie-mode
    // entries keeps undefined out of Firebase.
    const scalingFields = context.mode === 'grams'
      ? { grams: parseFloat(getElement('entryGrams').value), caloriesPer100g: context.caloriesPer100g }
      : null;

    if (context.entryId) {
      // Re-read before writing so we do not clobber another device's changes.
      const latestEntries = await loadLogForDate(selectedDate);
      const index = latestEntries.findIndex(candidate => candidate.id === context.entryId);
      if (index > -1) {
        const existing = latestEntries[index];
        // Rebuild rather than mutate, so a mode change cannot leave a stale
        // grams or caloriesPer100g behind. id and ts are preserved.
        latestEntries[index] = Object.assign({
          id: existing.id,
          name: name || existing.name,
          calories: calories,
          ts: existing.ts,
          meal: context.meal,
        }, scalingFields || {});
        await saveLogForDate(selectedDate, latestEntries);
        refreshLog();
      }
    } else {
      await addEntry(name || 'Untitled', calories, context.meal, scalingFields);
    }

    if (context.onSaved) context.onSaved();
    closeEntryModal();
  }

  getElement('entrySaveBtn').addEventListener('click', saveEntryModal);
  getElement('entryCancelBtn').addEventListener('click', closeEntryModal);

  // A click on the backdrop closes; a click inside the dialog must not, which
  // is what the target check gives us.
  getElement('entryModal').addEventListener('click', event => {
    if (event.target === getElement('entryModal')) closeEntryModal();
  });

  document.addEventListener('keydown', event => {
    if (!entryModalContext) return;
    if (event.key === 'Escape') {
      closeEntryModal();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      saveEntryModal();
    }
  });

  // ============================================================
  // 10. SIGN IN / SIGN OUT
  // Access control lives in the Firebase Realtime Database rules, not here.
  // This screen exists so the browser has a signed-in user to present; the
  // rules are what actually decide whether a read or write is allowed.
  // ============================================================

  /** Show the sign-in screen, hide the app. */
  function showSignInScreen() {
    getElement('signinScreen').style.display = 'flex';
    getElement('appWrap').style.display = 'none';
  }

  /** Show the app, hide the sign-in screen. */
  function showApp() {
    getElement('signinScreen').style.display = 'none';
    getElement('appWrap').style.display = 'block';
  }

  getElement('signinForm').addEventListener('submit', async event => {
    event.preventDefault();

    const email = getElement('signinEmail').value.trim();
    const password = getElement('signinPassword').value;
    const errorLabel = getElement('signinError');
    const submitButton = getElement('signinBtn');

    errorLabel.textContent = '';
    submitButton.disabled = true;
    submitButton.textContent = 'Signing in…';

    try {
      // On success, onAuthStateChanged below takes over and starts the app.
      await firebaseAuth.signInWithEmailAndPassword(email, password);
    } catch (error) {
      errorLabel.textContent = describeSignInError(error);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Sign in';
    }
  });

  /** Turn a Firebase auth error into something readable. */
  function describeSignInError(error) {
    switch (error.code) {
      case 'auth/invalid-email':
        return 'That does not look like an email address.';
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
        return 'Wrong email or password.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Wait a minute and try again.';
      case 'auth/network-request-failed':
        return 'No connection to Firebase.';
      default:
        return error.message || 'Sign-in failed.';
    }
  }

  getElement('signOutBtn').addEventListener('click', () => {
    firebaseAuth.signOut();
  });

  // ============================================================
  // 11. STARTUP
  // ============================================================

  async function init() {
    const settings = await loadSettings();
    if (settings.dailyTarget) dailyCalorieTarget = settings.dailyTarget;
    await refreshLog();
    await renderWeightHistory();
  }

  if (firebaseAuth) {
    // Fires once on load with the restored session (or null), and again on
    // every sign-in and sign-out. Firebase remembers the session per browser,
    // so you sign in once per device.
    firebaseAuth.onAuthStateChanged(user => {
      if (user) {
        getElement('signedInAs').textContent = user.email + ' · ';
        getElement('signOutBtn').style.display = 'inline';
        getElement('signinPassword').value = '';
        showApp();
        init();
      } else {
        showSignInScreen();
      }
    });
  } else {
    // No Firebase: run straight into the app against local storage.
    showApp();
    init();
  }
})();
