/**
 * Forecast submit progress popup (MMX hours + LifeLenz day parts).
 * Used by public/admin/app.js via window.FcProgress.
 */
(function () {
    const LIFELENZ_DAY_PARTS = [
        { key: 'overnightFirst', label: 'OVERNIGHT', hours: [5] },
        { key: 'breakfast', label: 'BREAKFAST', hours: [6, 7, 8, 9] },
        { key: 'morning', label: 'MORNING', hours: [10, 11] },
        { key: 'lunch', label: 'LUNCH', hours: [12, 13] },
        { key: 'afternoon', label: 'AFTERNOON', hours: [14, 15, 16] },
        { key: 'dinner', label: 'DINNER', hours: [17, 18, 19] },
        { key: 'afterDinner', label: 'AFTER DINNER', hours: [20, 21] },
        { key: 'lateNight', label: 'LATE NIGHT', hours: [22, 23] },
        { key: 'overnightSecond', label: 'OVERNIGHT', hours: [0, 1, 2, 3, 4] },
    ];

    let state = null;
    let abortController = null;
    let bound = false;

    function el(id) {
        return document.getElementById(id);
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatMoney(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return '—';
        return `$${Math.round(v).toLocaleString('en-AU')}`;
    }

    function formatHourLabel(hour) {
        const h = Number(hour);
        if (!Number.isFinite(h)) return '';
        const normalized = ((h % 24) + 24) % 24;
        if (normalized === 0) return '12:00 AM';
        if (normalized === 12) return '12:00 PM';
        if (normalized < 12) return `${normalized}:00 AM`;
        return `${normalized - 12}:00 PM`;
    }

    function formatShortDate(iso) {
        if (!iso) return '';
        try {
            const [y, m, d] = String(iso).split('-').map(Number);
            return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
            });
        } catch {
            return String(iso);
        }
    }

    function weekdayLabel(wd) {
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const n = Number(wd);
        return Number.isFinite(n) && names[n] ? names[n] : '';
    }

    function aggregateDayPartsFromHourly(hourly) {
        const map = new Map();
        for (const slot of hourly || []) {
            const hour = ((Number(slot.hour) % 24) + 24) % 24;
            if (!Number.isFinite(hour)) continue;
            map.set(hour, Number(slot.forecast) || 0);
        }
        return LIFELENZ_DAY_PARTS.map((part) => ({
            key: part.key,
            label: part.label,
            adjusted: Math.round(part.hours.reduce((sum, hour) => sum + (map.get(hour) || 0), 0)),
            status: 'pending',
            readValue: null,
            error: null,
        }));
    }

    function hourStatusLabel(status) {
        if (status === 'entering') return 'Entering…';
        if (status === 'verifying') return 'Confirming…';
        if (status === 'confirmed') return 'Confirmed';
        if (status === 'failed') return 'Failed';
        return 'Pending';
    }

    function dayStatusLabel(status) {
        if (status === 'filling') return 'Entering…';
        if (status === 'verifying') return 'Confirming…';
        if (status === 'saving') return 'Saving…';
        if (status === 'done') return 'Saved';
        if (status === 'error') return 'Failed';
        return 'Pending';
    }

    function findStore(storeNumber) {
        return (state?.stores || []).find((s) => String(s.storeNumber) === String(storeNumber));
    }

    function findDay(days, date) {
        return (days || []).find((d) => d.date === date);
    }

    function ensureStore(storeNumber) {
        let store = findStore(storeNumber);
        if (store) return store;
        store = {
            storeNumber: String(storeNumber),
            storeName: String(storeNumber),
            status: 'pending',
            mmxStatus: 'pending',
            lifelenzStatus: 'pending',
            mmxError: null,
            lifelenzError: null,
            lifelenzLiveLabel: null,
            days: [],
            lifelenzDays: [],
        };
        state.stores.push(store);
        return store;
    }

    function ensureLifelenzDay(store, mmxDay) {
        if (!store || !mmxDay?.date) return null;
        let day = findDay(store.lifelenzDays, mmxDay.date);
        if (!day) {
            day = {
                date: mmxDay.date,
                weekday: mmxDay.weekday,
                forecastTotal: mmxDay.forecastTotal,
                dayParts: aggregateDayPartsFromHourly(mmxDay.hourly),
                status: 'pending',
                error: null,
            };
            store.lifelenzDays.push(day);
            store.lifelenzDays.sort((a, b) => String(a.date).localeCompare(String(b.date)));
        }
        return day;
    }

    function initState(storeNumbers) {
        return {
            storeNumbers: storeNumbers.map(String),
            stores: storeNumbers.map((n) => ({
                storeNumber: String(n),
                storeName: String(n),
                status: 'pending',
                mmxStatus: 'pending',
                lifelenzStatus: 'pending',
                mmxError: null,
                lifelenzError: null,
                lifelenzLiveLabel: null,
                days: [],
                lifelenzDays: [],
            })),
            activeStore: storeNumbers[0] ? String(storeNumbers[0]) : null,
            activeDate: null,
            activeLifelenzDate: null,
            viewMmxDate: null,
            viewLifelenzDate: null,
            mmxViewPinned: false,
            lifelenzViewPinned: false,
            phase: 'mmx',
            lifelenzLiveLabel: null,
            statusLabel: null,
            cancelRequested: false,
            complete: false,
            error: null,
            results: null,
        };
    }

    function applyHourProgress(day, payload) {
        if (!day) return;
        let slot = (day.hourly || []).find((h) => Number(h.hour) === Number(payload.hour));
        if (!slot && payload.label) {
            slot = (day.hourly || []).find((h) => formatHourLabel(h.hour) === payload.label);
        }
        if (!slot) return;
        if (payload.type === 'hour-entering') {
            slot.status = 'entering';
            slot.error = null;
        } else if (payload.type === 'hour-verifying') {
            slot.status = 'verifying';
            slot.error = null;
        } else if (payload.type === 'hour-confirmed') {
            slot.status = 'confirmed';
            slot.readValue = payload.read ?? slot.readValue;
            slot.error = null;
        } else if (payload.type === 'hour-failed') {
            slot.status = 'failed';
            slot.readValue = payload.read ?? slot.readValue;
            slot.error = payload.reason || 'Failed';
        }
    }

    function applyDayPartProgress(day, payload) {
        if (!day?.dayParts?.length) return;
        if (payload.phase) {
            const overnight = day.dayParts[0];
            if (!overnight) return;
            overnight.status = payload.phase === 'quirk-finish' ? 'entering' : 'verifying';
            overnight.error = null;
            return;
        }
        const part =
            (payload.key && day.dayParts.find((p) => p.key === payload.key)) ||
            (payload.label && day.dayParts.find((p) => p.label === payload.label));
        if (!part) return;
        if (payload.type === 'daypart-entering') {
            part.status = 'entering';
            part.error = null;
        } else if (payload.type === 'daypart-confirmed') {
            part.status = 'confirmed';
            part.readValue = payload.read ?? payload.value ?? part.readValue;
            part.error = null;
        } else if (payload.type === 'daypart-failed') {
            part.status = 'failed';
            part.readValue = payload.read ?? part.readValue;
            part.error = payload.reason || 'Failed';
        }
    }

    function applyProgressEvent(payload) {
        if (!state || !payload?.type) return;

        if (payload.type === 'status') {
            state.statusLabel = payload.label || null;
            return;
        }
        state.statusLabel = null;

        if (payload.type === 'lifelenz-phase-start') {
            // MMX and LifeLenz now run together — keep both panes live when MMX already started.
            state.phase = state.phase === 'mmx' || state.phase === 'both' ? 'both' : 'lifelenz';
            state.lifelenzLiveLabel = 'Starting LifeLenz…';
            return;
        }

        if (payload.platform === 'lifelenz') {
            if (payload.type === 'session-start') {
                state.lifelenzLiveLabel = 'Signing in to LifeLenz…';
                return;
            }
            const store = payload.storeNumber ? ensureStore(payload.storeNumber) : findStore(state.activeStore);
            if (payload.type === 'store-start' && store) {
                store.lifelenzStatus = 'active';
                store.status = 'active';
                state.activeStore = String(payload.storeNumber);
                state.lifelenzLiveLabel = `Store ${payload.storeNumber} — starting LifeLenz…`;
            } else if (payload.type === 'day-start' && store) {
                state.activeStore = String(payload.storeNumber);
                state.activeLifelenzDate = payload.date;
                let day = findDay(store.lifelenzDays, payload.date);
                if (!day) {
                    day = {
                        date: payload.date,
                        weekday: payload.weekday,
                        forecastTotal: payload.forecastTotal,
                        dayParts: aggregateDayPartsFromHourly(payload.hourly),
                        status: 'filling',
                        error: null,
                    };
                    store.lifelenzDays.push(day);
                } else {
                    day.status = 'filling';
                    day.forecastTotal = payload.forecastTotal ?? day.forecastTotal;
                    if (!day.dayParts?.length) day.dayParts = aggregateDayPartsFromHourly(payload.hourly);
                }
                state.lifelenzLiveLabel = `Entering ${formatShortDate(payload.date)} day parts…`;
            } else if (
                store &&
                (payload.type === 'daypart-entering' ||
                    payload.type === 'daypart-confirmed' ||
                    payload.type === 'daypart-failed')
            ) {
                const date = payload.date || state.activeLifelenzDate;
                applyDayPartProgress(findDay(store.lifelenzDays, date), payload);
                if (payload.type === 'daypart-entering') {
                    state.lifelenzLiveLabel = payload.phase
                        ? `Overnight quirk (${payload.phase})…`
                        : `Entering ${payload.label || 'day part'}…`;
                } else if (payload.type === 'daypart-confirmed') {
                    state.lifelenzLiveLabel = `Confirmed ${payload.label || 'day part'}`;
                } else {
                    state.lifelenzLiveLabel = `Failed ${payload.label || 'day part'}`;
                }
                store.lifelenzLiveLabel = state.lifelenzLiveLabel;
            } else if (store && (payload.type === 'day-complete' || payload.type === 'day-skipped')) {
                const day = findDay(store.lifelenzDays, payload.date);
                if (day) {
                    day.status = 'done';
                    for (const part of day.dayParts || []) {
                        if (part.status !== 'failed') {
                            part.status = 'confirmed';
                            if (part.readValue == null) part.readValue = part.adjusted;
                        }
                    }
                }
                if (state.activeLifelenzDate === payload.date) state.activeLifelenzDate = null;
            } else if (store && (payload.type === 'store-complete' || payload.type === 'store-done')) {
                store.lifelenzStatus = payload.ok === false ? 'error' : 'done';
                if (payload.error) store.lifelenzError = payload.error;
                state.activeLifelenzDate = null;
            } else if (store && payload.type === 'store-error') {
                store.lifelenzStatus = 'error';
                store.lifelenzError = payload.error || 'LifeLenz submit failed';
            }
            return;
        }

        // MMX (default)
        const store = payload.storeNumber ? ensureStore(payload.storeNumber) : null;
        if (!store) return;

        if (payload.type === 'store-start') {
            store.mmxStatus = 'active';
            store.status = 'active';
            state.activeStore = String(payload.storeNumber);
            if (state.phase === 'lifelenz') state.phase = 'both';
            else if (!state.phase || state.phase === 'idle') state.phase = 'mmx';
        } else if (payload.type === 'day-start') {
            state.activeStore = String(payload.storeNumber);
            state.activeDate = payload.date;
            let day = findDay(store.days, payload.date);
            const hourly = (payload.hourly || []).map((slot) => ({
                hour: slot.hour,
                forecast: slot.forecast,
                status: 'pending',
                readValue: null,
                error: null,
            }));
            if (!day) {
                day = {
                    date: payload.date,
                    weekday: payload.weekday,
                    forecastTotal: payload.forecastTotal,
                    hourly,
                    status: 'filling',
                    error: null,
                };
                store.days.push(day);
                store.days.sort((a, b) => String(a.date).localeCompare(String(b.date)));
            } else {
                day.weekday = payload.weekday ?? day.weekday;
                day.forecastTotal = payload.forecastTotal ?? day.forecastTotal;
                if (hourly.length) day.hourly = hourly;
                day.status = 'filling';
            }
            ensureLifelenzDay(store, day);
        } else if (payload.type === 'day-filling') {
            state.activeDate = payload.date;
            const day = findDay(store.days, payload.date);
            if (day) day.status = 'filling';
        } else if (payload.type === 'day-verifying') {
            state.activeDate = payload.date;
            const day = findDay(store.days, payload.date);
            if (day) day.status = 'verifying';
        } else if (
            payload.type === 'hour-entering' ||
            payload.type === 'hour-verifying' ||
            payload.type === 'hour-confirmed' ||
            payload.type === 'hour-failed'
        ) {
            state.activeDate = payload.date;
            applyHourProgress(findDay(store.days, payload.date), payload);
        } else if (payload.type === 'day-saving') {
            state.activeDate = payload.date;
            const day = findDay(store.days, payload.date);
            if (day) day.status = 'saving';
        } else if (payload.type === 'day-done' || payload.type === 'day-skipped') {
            const day = findDay(store.days, payload.date);
            if (day) day.status = 'done';
            if (state.activeDate === payload.date) state.activeDate = null;
        } else if (payload.type === 'store-done' || payload.type === 'store-complete') {
            store.mmxStatus = payload.ok === false ? 'error' : 'done';
            if (payload.error) store.mmxError = payload.error;
            state.activeDate = null;
        } else if (payload.type === 'store-error') {
            store.mmxStatus = 'error';
            store.mmxError = payload.error || 'Submit failed';
            state.activeDate = null;
        }
    }

    function mmxDaySummary(day) {
        if (!day) return '—';
        if (day.status === 'done') {
            const n = (day.hourly || []).filter((h) => h.status === 'confirmed').length;
            return n ? `${n}h · ${formatMoney(day.forecastTotal)}` : formatMoney(day.forecastTotal);
        }
        if (day.status === 'error') return day.error || 'Failed';
        if (day.status === 'filling' || day.status === 'verifying' || day.status === 'saving') {
            const done = (day.hourly || []).filter((h) => h.status === 'confirmed').length;
            const total = (day.hourly || []).length;
            return total ? `${done}/${total} · ${dayStatusLabel(day.status)}` : dayStatusLabel(day.status);
        }
        return day.forecastTotal != null ? `Pending · ${formatMoney(day.forecastTotal)}` : 'Pending';
    }

    function llDaySummary(day, liveLabel) {
        if (!day) return '—';
        if (day.status === 'done') return formatMoney(day.forecastTotal);
        if (day.status === 'error') return day.error || 'Failed';
        if (day.status === 'filling' && liveLabel) return liveLabel;
        return dayStatusLabel(day.status);
    }

    function colStatus(day, active) {
        if (!day) return 'pending';
        if (day.status === 'error') return 'error';
        if (day.status === 'done') return 'done';
        if (active || ['filling', 'verifying', 'saving'].includes(day.status)) return 'active';
        return 'pending';
    }

    function activeHourMessage(day) {
        if (!day?.hourly?.length) return dayStatusLabel(day?.status);
        const active =
            [...day.hourly].reverse().find((s) => s.status === 'entering' || s.status === 'verifying') ||
            day.hourly.find((s) => s.status === 'entering' || s.status === 'verifying');
        if (active) {
            const label = formatHourLabel(active.hour);
            return active.status === 'verifying'
                ? `Confirming sales for ${label}…`
                : `Entering sales for ${label}…`;
        }
        if (day.status === 'verifying') return 'Double-checking all hours…';
        if (day.status === 'saving') return 'Saving day to Macromatix…';
        const confirmed = day.hourly.filter((s) => s.status === 'confirmed').length;
        if (confirmed) return `${confirmed} of ${day.hourly.length} hours confirmed`;
        return dayStatusLabel(day.status);
    }

    function activeDayPartMessage(day, liveLabel) {
        if (liveLabel) return liveLabel;
        if (!day?.dayParts?.length) return 'Waiting for LifeLenz…';
        const active = day.dayParts.find((p) => p.status === 'entering' || p.status === 'verifying');
        if (active) return `Entering ${active.label}…`;
        const confirmed = day.dayParts.filter((p) => p.status === 'confirmed').length;
        if (confirmed) return `${confirmed} of ${day.dayParts.length} day parts confirmed`;
        return dayStatusLabel(day.status);
    }

    function resolveViewDay(days, viewDate, autoDay) {
        if (viewDate) {
            const viewed = findDay(days, viewDate);
            if (viewed) return viewed;
        }
        return autoDay || null;
    }

    function buildDayNav(day, days, channel) {
        const idx = (days || []).findIndex((d) => d.date === day?.date);
        const showPrev = idx > 0;
        const showNext = idx >= 0 && idx < (days || []).length - 1;
        return `
            <div class="fc-progress-detail-nav">
                <button type="button" class="fc-progress-day-nav" data-progress-day-nav data-channel="${channel}" data-dir="-1"${showPrev ? '' : ' hidden'}>‹</button>
                <div>
                    <span class="fc-progress-detail-date">${escapeHtml(formatShortDate(day.date))}</span>
                    <span class="fc-progress-detail-weekday">${escapeHtml(weekdayLabel(day.weekday))}</span>
                </div>
                <button type="button" class="fc-progress-day-nav" data-progress-day-nav data-channel="${channel}" data-dir="1"${showNext ? '' : ' hidden'}>›</button>
            </div>
            <span class="fc-progress-detail-total">${formatMoney(day.forecastTotal)}</span>`;
    }

    function buildMmxDetail(day, days) {
        if (!day) return '<p class="fc-progress-meta">Waiting for the next day…</p>';
        const rows = (day.hourly || [])
            .map((slot) => {
                const status = slot.status || 'pending';
                return `<tr class="fc-progress-hour-row--${status}" data-hour="${escapeHtml(String(slot.hour))}">
                    <th scope="row">${escapeHtml(formatHourLabel(slot.hour))}</th>
                    <td>${formatMoney(slot.forecast)}</td>
                    <td class="fc-progress-hour-status">${escapeHtml(hourStatusLabel(status))}</td>
                </tr>`;
            })
            .join('');
        return `
            <div class="fc-progress-detail-head">${buildDayNav(day, days, 'mmx')}</div>
            <p class="fc-progress-live">${escapeHtml(activeHourMessage(day))}</p>
            <table class="fc-progress-hour-table">
                <thead><tr><th>Hour</th><th>Forecast</th><th>Status</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="3">No hourly values</td></tr>'}</tbody>
            </table>`;
    }

    function buildLlDetail(day, days, liveLabel) {
        if (!day) return '<p class="fc-progress-meta">Waiting for LifeLenz…</p>';
        const rows = (day.dayParts || [])
            .map((part) => {
                const status = part.status || 'pending';
                return `<tr class="fc-progress-hour-row--${status}" data-daypart-key="${escapeHtml(part.key)}">
                    <th scope="row">${escapeHtml(part.label)}</th>
                    <td>${formatMoney(part.adjusted)}</td>
                    <td class="fc-progress-hour-status">${escapeHtml(hourStatusLabel(status))}</td>
                </tr>`;
            })
            .join('');
        return `
            <div class="fc-progress-detail-head">${buildDayNav(day, days, 'lifelenz')}</div>
            <p class="fc-progress-live">${escapeHtml(activeDayPartMessage(day, liveLabel))}</p>
            <table class="fc-progress-hour-table">
                <thead><tr><th>Day part</th><th>Forecast</th><th>Status</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="3">No day parts</td></tr>'}</tbody>
            </table>`;
    }

    function patchMmxDetail(detailEl, day, days) {
        if (!day) {
            detailEl.dataset.activeDate = '';
            detailEl.innerHTML = '<p class="fc-progress-meta">Waiting for the next day…</p>';
            return;
        }
        if (detailEl.dataset.activeDate !== day.date) {
            detailEl.dataset.activeDate = day.date;
            detailEl.innerHTML = buildMmxDetail(day, days);
            return;
        }
        const live = detailEl.querySelector('.fc-progress-live');
        if (live) live.textContent = activeHourMessage(day);
        for (const slot of day.hourly || []) {
            const row = detailEl.querySelector(`tr[data-hour="${String(slot.hour)}"]`);
            if (!row) continue;
            const status = slot.status || 'pending';
            row.className = `fc-progress-hour-row--${status}`;
            const statusEl = row.querySelector('.fc-progress-hour-status');
            if (statusEl) statusEl.textContent = hourStatusLabel(status);
        }
    }

    function patchLlDetail(detailEl, day, days, liveLabel) {
        if (!day) {
            detailEl.dataset.activeDate = '';
            detailEl.innerHTML = '<p class="fc-progress-meta">Waiting for LifeLenz…</p>';
            return;
        }
        if (detailEl.dataset.activeDate !== day.date) {
            detailEl.dataset.activeDate = day.date;
            detailEl.innerHTML = buildLlDetail(day, days, liveLabel);
            return;
        }
        const live = detailEl.querySelector('.fc-progress-live');
        if (live) live.textContent = activeDayPartMessage(day, liveLabel);
        for (const part of day.dayParts || []) {
            const row = detailEl.querySelector(`tr[data-daypart-key="${part.key}"]`);
            if (!row) continue;
            const status = part.status || 'pending';
            row.className = `fc-progress-hour-row--${status}`;
            const statusEl = row.querySelector('.fc-progress-hour-status');
            if (statusEl) statusEl.textContent = hourStatusLabel(status);
        }
    }

    function setCloseEnabled(enabled, label) {
        const btn = el('fc-progress-close');
        const cancel = el('fc-progress-cancel');
        if (btn) {
            btn.disabled = !enabled;
            btn.textContent = label || (enabled ? 'Done' : 'Submitting…');
        }
        if (cancel) {
            cancel.hidden = enabled;
            if (!enabled) {
                if (state?.cancelRequested) {
                    cancel.disabled = true;
                    cancel.textContent = 'Cancelling…';
                } else {
                    cancel.disabled = false;
                    cancel.textContent = 'Cancel';
                }
            }
        }
    }

    function renderWorking() {
        if (!state || state.complete) return;
        el('fc-progress-working').hidden = false;
        el('fc-progress-done').hidden = true;
        setCloseEnabled(false, 'Submitting…');

        const activeStore = findStore(state.activeStore) || state.stores[0];
        const mmxDone = state.stores.filter((s) => s.mmxStatus === 'done').length;
        const llDone = state.stores.filter((s) => s.lifelenzStatus === 'done').length;
        const mmxAllDone = mmxDone === state.stores.length && state.stores.length > 0;
        const lifelenzActive =
            state.phase === 'lifelenz' ||
            state.stores.some((s) => s.lifelenzStatus === 'active') ||
            (mmxAllDone && llDone < state.stores.length);

        el('fc-progress-title').textContent =
            lifelenzActive && mmxAllDone ? 'Submitting forecast to LifeLenz' : 'Submitting forecast';

        let meta = activeStore
            ? `Store ${activeStore.storeNumber} · MMX ${mmxDone}/${state.stores.length} · LifeLenz ${llDone}/${state.stores.length}`
            : 'Starting…';
        if (state.statusLabel) meta = `${state.statusLabel} · ${meta}`;
        el('fc-progress-meta').textContent = meta;

        const autoMmx =
            findDay(activeStore?.days, state.activeDate) ||
            activeStore?.days.find((d) => ['filling', 'verifying', 'saving'].includes(d.status)) ||
            activeStore?.days.find((d) => d.status === 'pending') ||
            activeStore?.days[activeStore.days.length - 1] ||
            null;
        const autoLl =
            findDay(activeStore?.lifelenzDays, state.activeLifelenzDate) ||
            activeStore?.lifelenzDays.find((d) => d.status === 'filling') ||
            activeStore?.lifelenzDays.find((d) => d.status === 'pending') ||
            activeStore?.lifelenzDays[0] ||
            null;
        const mmxDay = resolveViewDay(activeStore?.days, state.mmxViewPinned ? state.viewMmxDate : null, autoMmx);
        const llDay = resolveViewDay(
            activeStore?.lifelenzDays,
            state.lifelenzViewPinned ? state.viewLifelenzDate : null,
            autoLl
        );

        const weekEl = el('fc-progress-week-rows');
        const mmxDays = activeStore?.days || [];
        const llByDate = new Map((activeStore?.lifelenzDays || []).map((d) => [d.date, d]));
        const liveLabel = activeStore?.lifelenzLiveLabel || state.lifelenzLiveLabel || '';

        mmxDays.forEach((mmx, index) => {
            const ll = llByDate.get(mmx.date) || activeStore?.lifelenzDays?.[index];
            const mmxActive = mmx.date === state.activeDate && mmx.status !== 'done' && mmx.status !== 'error';
            const llActive =
                ll?.date === state.activeLifelenzDate && ll?.status !== 'done' && ll?.status !== 'error';
            let row = weekEl.children[index];
            if (!row || row.dataset.date !== mmx.date) {
                row = document.createElement('li');
                row.dataset.date = mmx.date;
                row.className = 'fc-progress-week-row';
                row.innerHTML =
                    '<span class="fc-progress-week-day"></span>' +
                    '<span class="fc-progress-week-mmx"></span>' +
                    '<span class="fc-progress-week-ll"></span>';
                if (weekEl.children[index]) weekEl.replaceChild(row, weekEl.children[index]);
                else weekEl.appendChild(row);
            }
            row.className = `fc-progress-week-row${mmxActive || llActive ? ' is-active' : ''}`;
            row.querySelector('.fc-progress-week-day').textContent =
                weekdayLabel(mmx.weekday) || formatShortDate(mmx.date);
            const mmxEl = row.querySelector('.fc-progress-week-mmx');
            const llEl = row.querySelector('.fc-progress-week-ll');
            mmxEl.textContent = mmxDaySummary(mmx);
            llEl.textContent = llDaySummary(ll, llActive ? liveLabel : '');
            mmxEl.className = `fc-progress-week-mmx fc-progress-week-col--${colStatus(mmx, mmxActive)}`;
            llEl.className = `fc-progress-week-ll fc-progress-week-col--${colStatus(ll, llActive)}`;
        });
        while (weekEl.children.length > mmxDays.length) weekEl.removeChild(weekEl.lastChild);

        patchMmxDetail(el('fc-progress-mmx-detail'), mmxDay, activeStore?.days || []);
        patchLlDetail(el('fc-progress-lifelenz-detail'), llDay, activeStore?.lifelenzDays || [], liveLabel);
    }

    function renderComplete(payload) {
        state.complete = true;
        state.results = payload;
        el('fc-progress-working').hidden = true;
        el('fc-progress-done').hidden = false;
        setCloseEnabled(true, 'Done');

        const results = payload?.results || [];
        const failed = results.filter((r) => r.state === 'error' || r.ok === false);
        const cancelled = Boolean(payload?.cancelled);
        el('fc-progress-done-title').textContent = cancelled
            ? 'Forecast cancelled'
            : failed.length
              ? 'Forecast finished with errors'
              : 'Forecast entered';
        el('fc-progress-done-meta').textContent = cancelled
            ? 'Remaining days were not submitted.'
            : `${results.length} store(s)${failed.length ? ` · ${failed.length} failed` : ''}`;

        el('fc-progress-done-results').innerHTML =
            results
                .map((r) => {
                    const mmxErr = r.submit?.mmx?.error;
                    const lzErr = r.submit?.lifelenz?.error;
                    const ok = r.ok !== false && r.state !== 'error';
                    return `<div class="fc-progress-done-store">
                        <strong>${escapeHtml(r.storeNumber || '?')}</strong>
                        <div style="color:${ok ? 'var(--ok)' : 'var(--bad)'}">${escapeHtml(r.message || r.state || '')}</div>
                        ${mmxErr ? `<div style="color:var(--bad);font-size:.82rem">MMX: ${escapeHtml(mmxErr)}</div>` : ''}
                        ${lzErr ? `<div style="color:var(--bad);font-size:.82rem">LifeLenz: ${escapeHtml(lzErr)}</div>` : ''}
                    </div>`;
                })
                .join('') || '<p class="fc-progress-meta">No results.</p>';

        if (payload?.error || state.error) {
            el('fc-progress-error').textContent = payload?.error || state.error;
        }
    }

    function bindOnce() {
        if (bound) return;
        bound = true;
        el('fc-progress-close')?.addEventListener('click', () => {
            if (!state?.complete && !state?.error) return;
            close();
        });
        el('fc-progress-cancel')?.addEventListener('click', () => {
            if (!abortController) return;
            if (state) state.cancelRequested = true;
            setCloseEnabled(false, 'Submitting…');
            abortController.abort();
        });
        el('fc-progress-backdrop')?.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-progress-day-nav]');
            if (!btn || !state) return;
            const channel = btn.getAttribute('data-channel');
            const dir = Number(btn.getAttribute('data-dir'));
            const store = findStore(state.activeStore) || state.stores[0];
            if (!store || !Number.isFinite(dir)) return;
            const days = channel === 'lifelenz' ? store.lifelenzDays : store.days;
            const viewKey = channel === 'lifelenz' ? 'viewLifelenzDate' : 'viewMmxDate';
            const pinKey = channel === 'lifelenz' ? 'lifelenzViewPinned' : 'mmxViewPinned';
            const current =
                state[viewKey] ||
                (channel === 'lifelenz' ? state.activeLifelenzDate : state.activeDate) ||
                days[0]?.date;
            const idx = days.findIndex((d) => d.date === current);
            const next = days[idx + dir];
            if (!next) return;
            state[viewKey] = next.date;
            state[pinKey] = true;
            renderWorking();
        });
    }

    function open(storeNumbers) {
        bindOnce();
        state = initState(storeNumbers);
        const backdrop = el('fc-progress-backdrop');
        backdrop.classList.add('open');
        backdrop.setAttribute('aria-hidden', 'false');
        el('fc-progress-error').textContent = '';
        el('fc-progress-week-rows').innerHTML = '';
        el('fc-progress-mmx-detail').innerHTML = '<p class="fc-progress-meta">Waiting for Macromatix…</p>';
        el('fc-progress-lifelenz-detail').innerHTML = '<p class="fc-progress-meta">Waiting for LifeLenz…</p>';
        renderWorking();
    }

    function close() {
        const backdrop = el('fc-progress-backdrop');
        backdrop?.classList.remove('open');
        backdrop?.setAttribute('aria-hidden', 'true');
        state = null;
        abortController = null;
    }

    function handleEvent(eventName, data) {
        if (eventName === 'progress') {
            applyProgressEvent(data);
            renderWorking();
            return;
        }
        if (eventName === 'platform-started') {
            if (data?.platform === 'lifelenz') state.phase = state.phase === 'mmx' ? 'both' : state.phase;
            if (data?.platform === 'mmx') state.statusLabel = 'Starting Macromatix…';
            renderWorking();
            return;
        }
        if (eventName === 'lifelenz-started') {
            applyProgressEvent({ type: 'lifelenz-phase-start' });
            renderWorking();
            return;
        }
        if (eventName === 'started') {
            state.statusLabel = 'Connected — starting…';
            renderWorking();
        }
    }

    async function consumeSseStream(response, onEvent) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop() || '';
            for (const chunk of chunks) {
                if (!chunk.trim()) continue;
                let eventName = 'message';
                let dataLine = '';
                for (const line of chunk.split('\n')) {
                    if (line.startsWith('event: ')) eventName = line.slice(7).trim();
                    else if (line.startsWith('data: ')) dataLine = line.slice(6);
                }
                if (!dataLine) continue;
                onEvent(eventName, JSON.parse(dataLine));
            }
        }
    }

    async function run(storeNumbers, { all = false } = {}) {
        open(storeNumbers.length ? storeNumbers : ['…']);
        abortController = new AbortController();
        try {
            const body = all ? { all: true, streamProgress: true } : { storeNumbers, streamProgress: true };
            const res = await fetch('/api/admin/forecast/run', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                credentials: 'same-origin',
                body: JSON.stringify(body),
                signal: abortController.signal,
            });
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('text/event-stream') && res.body) {
                let finalPayload = null;
                await consumeSseStream(res, (eventName, data) => {
                    if (eventName === 'complete' || eventName === 'error') finalPayload = data;
                    else handleEvent(eventName, data);
                });
                if (!finalPayload) throw new Error('The server closed the connection before finishing.');
                if (finalPayload.error && !finalPayload.results) {
                    state.error = finalPayload.error;
                    el('fc-progress-error').textContent = finalPayload.error;
                }
                renderComplete(finalPayload);
                return finalPayload;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) throw new Error(data.error || 'Forecast run failed.');
            renderComplete(data);
            return data;
        } catch (err) {
            if (err?.name === 'AbortError') {
                const cancelled = {
                    success: false,
                    cancelled: true,
                    error: 'Cancelled — remaining days were not submitted.',
                    results: state?.results || [],
                };
                renderComplete(cancelled);
                return cancelled;
            }
            state.error = err.message || String(err);
            el('fc-progress-error').textContent = state.error;
            renderComplete({
                success: false,
                error: state.error,
                results: [],
            });
            throw err;
        } finally {
            abortController = null;
        }
    }

    window.FcProgress = {
        open,
        close,
        run,
        handleEvent,
        getState: () => state,
    };
})();
