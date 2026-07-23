/**
 * CORE audit round countdown for MIC overview tiles.
 * Round dates live in /data/core-rounds.json.
 */
(function (global) {
    const CONFIG_URL = '/data/core-rounds.json';
    const DEFAULT_CONFIG = {
        timezone: 'Australia/Melbourne',
        rounds: [
            {
                id: 'R1',
                label: 'Round 1',
                start: { month: 1, day: 1, periodWeek: 'P9W4' },
                end: { month: 4, day: 30, periodWeek: 'P13W5' },
            },
            {
                id: 'R2',
                label: 'Round 2',
                start: { month: 5, day: 1, periodWeek: 'P13W5' },
                end: { month: 8, day: 31, periodWeek: 'P5W2' },
            },
            {
                id: 'R3',
                label: 'Round 3',
                start: { month: 9, day: 1, periodWeek: 'P5W2' },
                end: { month: 12, day: 31, periodWeek: 'P9W3' },
            },
        ],
    };

    let config = DEFAULT_CONFIG;
    let configPromise = null;
    let tickInterval = null;

    const MONTHS = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function ordinalDay(day) {
        const n = Number(day) || 0;
        const mod100 = n % 100;
        if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
        switch (n % 10) {
            case 1:
                return `${n}st`;
            case 2:
                return `${n}nd`;
            case 3:
                return `${n}rd`;
            default:
                return `${n}th`;
        }
    }

    function formatRoundBoundary(datePart) {
        const month = MONTHS[(Number(datePart?.month) || 1) - 1] || 'Jan';
        const day = ordinalDay(datePart?.day || 1);
        const periodWeek = String(datePart?.periodWeek || '').trim();
        return periodWeek ? `${month} ${day} (${periodWeek})` : `${month} ${day}`;
    }

    function formatRoundScheduleLine(round) {
        return `${round.id}: ${formatRoundBoundary(round.start)} - ${formatRoundBoundary(round.end)}`;
    }

    function zonedParts(date, timeZone) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).formatToParts(date);
        const get = (type) => parts.find((part) => part.type === type)?.value;
        return {
            year: Number(get('year')),
            month: Number(get('month')),
            day: Number(get('day')),
            hour: Number(get('hour')),
            minute: Number(get('minute')),
            second: Number(get('second')),
        };
    }

    function zonedDateToUtcMs(year, month, day, hour, minute, second, timeZone) {
        let guess = Date.UTC(year, month - 1, day, hour, minute, second);
        for (let i = 0; i < 3; i += 1) {
            const zoned = zonedParts(new Date(guess), timeZone);
            const desired = Date.UTC(year, month - 1, day, hour, minute, second);
            const actual = Date.UTC(
                zoned.year,
                zoned.month - 1,
                zoned.day,
                zoned.hour,
                zoned.minute,
                zoned.second
            );
            guess += desired - actual;
        }
        return guess;
    }

    function monthDayKey(month, day) {
        return Number(month) * 100 + Number(day);
    }

    function isDateInRound(round, month, day) {
        const current = monthDayKey(month, day);
        const start = monthDayKey(round.start.month, round.start.day);
        const end = monthDayKey(round.end.month, round.end.day);
        return current >= start && current <= end;
    }

    function getActiveRound(now = new Date(), rounds = config.rounds) {
        const timeZone = config.timezone || DEFAULT_CONFIG.timezone;
        const { month, day } = zonedParts(now, timeZone);
        return (rounds || []).find((round) => isDateInRound(round, month, day)) || rounds?.[0] || null;
    }

    function getRoundEndMs(round, now = new Date()) {
        if (!round) return now.getTime();
        const timeZone = config.timezone || DEFAULT_CONFIG.timezone;
        const { year } = zonedParts(now, timeZone);
        return zonedDateToUtcMs(
            year,
            round.end.month,
            round.end.day,
            23,
            59,
            59,
            timeZone
        );
    }

    function getCountdownParts(endMs, now = new Date()) {
        const remainingMs = Math.max(0, endMs - now.getTime());
        const totalSeconds = Math.floor(remainingMs / 1000);
        return {
            days: Math.floor(totalSeconds / 86400),
            hours: Math.floor((totalSeconds % 86400) / 3600),
            minutes: Math.floor((totalSeconds % 3600) / 60),
            seconds: totalSeconds % 60,
        };
    }

    function renderCountdownDigits(parts) {
        const units = [
            { key: 'days', label: 'days', value: parts.days },
            { key: 'hrs', label: 'hrs', value: parts.hours },
            { key: 'min', label: 'min', value: parts.minutes },
            { key: 'sec', label: 'sec', value: parts.seconds },
        ];
        return units
            .map(
                ({ key, label, value }) => `
            <div class="mic-core-countdown-unit">
                <span class="mic-core-countdown-value" data-core-unit="${key}">${pad2(value)}</span>
                <span class="mic-core-countdown-unit-label">${label}</span>
            </div>`
            )
            .join('');
    }

    function renderScheduleLines(rounds = config.rounds) {
        return (rounds || [])
            .map((round) => `<div class="mic-core-countdown-schedule-line">${formatRoundScheduleLine(round)}</div>`)
            .join('');
    }

    function renderTileHtml({ tabbed = false, inRow = false } = {}) {
        const round = getActiveRound();
        const endMs = getRoundEndMs(round);
        const parts = getCountdownParts(endMs);
        const posClass = tabbed || inRow ? '' : ' mic-tile--pos-core-countdown';
        const roundLabel = round?.label || 'CORE Round';
        return `
        <article class="mic-tile mic-tile--core-countdown${posClass}" data-core-countdown data-core-end-ms="${endMs}">
            <div class="mic-core-countdown-bg" aria-hidden="true"></div>
            <div class="mic-tile-body mic-core-countdown-body">
                <div class="mic-core-countdown-round" data-core-round-label>${roundLabel}</div>
                <div class="mic-core-countdown-clock" aria-live="polite" aria-label="CORE round countdown">
                    ${renderCountdownDigits(parts)}
                </div>
                <div class="mic-core-countdown-schedule" data-core-schedule>
                    ${renderScheduleLines()}
                </div>
            </div>
        </article>`;
    }

    function updateTileElement(tile) {
        if (!tile) return;
        const endMs = Number(tile.dataset.coreEndMs);
        if (!Number.isFinite(endMs)) return;
        const parts = getCountdownParts(endMs);
        tile.querySelectorAll('[data-core-unit]').forEach((el) => {
            const key = el.dataset.coreUnit;
            if (key === 'days') el.textContent = pad2(parts.days);
            if (key === 'hrs') el.textContent = pad2(parts.hours);
            if (key === 'min') el.textContent = pad2(parts.minutes);
            if (key === 'sec') el.textContent = pad2(parts.seconds);
        });
    }

    function refreshTiles() {
        document.querySelectorAll('[data-core-countdown]').forEach(updateTileElement);
    }

    function startTick() {
        stopTick();
        tickInterval = global.setInterval(refreshTiles, 1000);
    }

    function stopTick() {
        if (tickInterval) {
            global.clearInterval(tickInterval);
            tickInterval = null;
        }
    }

    async function init() {
        if (!configPromise) {
            configPromise = fetch(CONFIG_URL, { credentials: 'same-origin' })
                .then((res) => (res.ok ? res.json() : DEFAULT_CONFIG))
                .then((data) => {
                    if (data && Array.isArray(data.rounds) && data.rounds.length) {
                        config = { ...DEFAULT_CONFIG, ...data, rounds: data.rounds };
                    }
                    return config;
                })
                .catch(() => {
                    config = DEFAULT_CONFIG;
                    return config;
                });
        }
        return configPromise;
    }

    global.CoreCountdown = {
        init,
        renderTileHtml,
        refreshTiles,
        startTick,
        stopTick,
        getActiveRound,
        getCountdownParts,
    };
})(window);
