/**
 * Portrait-style sales grid for MIC overview (matches mobile store dashboard list layout).
 */
(function () {
    const MEAL_SPLIT_HOUR = 15;
    const DEFAULT_TZ = 'Australia/Melbourne';
    /** Macromatix hourly arrays: index 0 = 5AM local. */
    const RAW_BASE_HOUR = 5;

    const paceFillMap = window.SalesProgress?.paceFillMap || {
        'cell-green': 'var(--good)',
        'cell-orange': 'var(--near)',
        'cell-red': 'var(--bad)',
    };

    const paceBorderMap = window.SalesProgress?.paceBorderMap || {
        'cell-green': 'var(--good-border)',
        'cell-orange': 'var(--near-border)',
        'cell-red': 'var(--bad-border)',
    };

    function formatCurrency(value) {
        const n = Number(value) || 0;
        return `$${Math.round(n).toLocaleString('en-AU')}`;
    }

    function hourLabel(hour) {
        const h = (((Math.trunc(hour) % 24) + 24) % 24);
        const period = h < 12 ? 'AM' : 'PM';
        const display = h % 12 === 0 ? 12 : h % 12;
        return `${display}${period}`;
    }

    function clampInt(value, min, max) {
        const n = Math.trunc(Number(value));
        if (!Number.isFinite(n)) return min;
        return Math.max(min, Math.min(max, n));
    }

    function zoneHourMinuteSecond(timeZone, d = new Date()) {
        const parts = new Intl.DateTimeFormat('en-AU', {
            timeZone: String(timeZone || DEFAULT_TZ),
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).formatToParts(d);
        const get = (type) => Number(parts.find((p) => p.type === type)?.value);
        return { hour: get('hour'), minute: get('minute'), second: get('second') };
    }

    function getActualCellClass(actual, forecast) {
        const f = Number(forecast) || 0;
        const a = Number(actual) || 0;
        if (f <= 0) return 'cell-green';
        const ratio = (a - f) / f;
        if (ratio >= 0) return 'cell-green';
        if (ratio >= -0.1) return 'cell-orange';
        return 'cell-red';
    }

    function getPaceClass(actual, forecast, elapsedProgress) {
        const f = Number(forecast) || 0;
        const a = Number(actual) || 0;
        const p = Number(elapsedProgress) || 0;
        if (f <= 0 || p <= 0) return 'cell-green';
        const expectedSales = f * p;
        if (a >= expectedSales) return 'cell-green';
        const shortfall = (expectedSales - a) / expectedSales;
        if (shortfall <= 0.1) return 'cell-orange';
        return 'cell-red';
    }

    function sumHourSlice(values, start, end) {
        return values.slice(start, end).reduce((sum, v) => sum + (Number(v) || 0), 0);
    }

    function getCurrentHourProgress(openHour, hourCount, timeZone) {
        const startHour = Number(openHour) || 10;
        const tradeEndHourExclusive = startHour + hourCount;
        const gridColoursEndHourExclusive = tradeEndHourExclusive + 1;
        const { hour, minute, second } = zoneHourMinuteSecond(timeZone);

        if (hour < startHour || hour >= gridColoursEndHourExclusive) {
            return { hourIndex: -1, progress: 0 };
        }
        if (hour >= tradeEndHourExclusive) {
            return { hourIndex: hourCount, progress: 1 };
        }
        const hourIndex = hour - startHour;
        const progress = minute / 60 + second / 3600;
        return { hourIndex, progress };
    }

    function getWallClockPeriodProgress(startHour, endHourExclusive, timeZone) {
        const { hour, minute, second } = zoneHourMinuteSecond(timeZone);
        const nowHourFloat = hour + minute / 60 + second / 3600;
        if (nowHourFloat <= startHour) return 0;
        if (nowHourFloat >= endHourExclusive) return 1;
        return (nowHourFloat - startHour) / (endHourExclusive - startHour);
    }

    function getPeriodExpectedSoFarSlice(forecasts, startIdx, endExclusive, hourProgress) {
        const { hourIndex, progress } = hourProgress;
        let expected = 0;
        for (let i = startIdx; i < endExclusive; i++) {
            const f = Number(forecasts[i]) || 0;
            if (hourIndex < 0) break;
            if (i < hourIndex) expected += f;
            else if (i === hourIndex) {
                expected += f * progress;
                break;
            } else break;
        }
        return expected;
    }

    function getPeriodActualSoFarSlice(actuals, startIdx, endExclusive, hourProgress) {
        const { hourIndex } = hourProgress;
        if (hourIndex < 0) return 0;
        let actual = 0;
        for (let i = startIdx; i < endExclusive; i++) {
            if (i <= hourIndex) actual += Number(actuals[i]) || 0;
            else break;
        }
        return actual;
    }

    function buildLiveProgressLayersHtml(timeFillPercent, outcomeClass, paceClass) {
        if (window.SalesProgress?.buildLiveProgressLayersHtml) {
            return window.SalesProgress.buildLiveProgressLayersHtml(timeFillPercent, outcomeClass, paceClass);
        }
        return '';
    }

    function buildHourlyDataCell({ index, hourProgress, forecast, actual, displayValue, portraitPastLive = false }) {
        const isFuture = index > hourProgress.hourIndex;
        if (isFuture) {
            return `<div class="grid-cell portrait-data-cell">${formatCurrency(displayValue)}</div>`;
        }

        const fn = Number(forecast) || 0;
        const an = Number(actual) || 0;
        const isCurrentHour = index === hourProgress.hourIndex && hourProgress.hourIndex >= 0;

        if (!isCurrentHour) {
            const cellClass = getActualCellClass(an, fn);
            if (portraitPastLive && cellClass) {
                const paceClass = fn > 0 ? getPaceClass(an, fn, 1) : 'cell-green';
                const layers = buildLiveProgressLayersHtml(100, cellClass, paceClass);
                const outcomeBorder = paceBorderMap[cellClass] || 'var(--blank-border)';
                return `<div class="grid-cell grid-cell--live-hour portrait-data-cell" style="border: var(--cell-border) ${outcomeBorder};">${layers}<span class="grid-cell-live-value">${formatCurrency(displayValue)}</span></div>`;
            }
            return `<div class="grid-cell portrait-data-cell${cellClass ? ` ${cellClass}` : ''}">${formatCurrency(displayValue)}</div>`;
        }

        const { progress } = hourProgress;
        const paceClass = getPaceClass(an, fn, progress);
        const outcomeClass = getActualCellClass(an, fn);
        const progressPct = Math.round(progress * 1000) / 10;
        const layers = buildLiveProgressLayersHtml(progressPct, outcomeClass, paceClass);
        const outcomeBorder = paceBorderMap[outcomeClass] || 'var(--blank-border)';
        return `<div class="grid-cell grid-cell--live-hour portrait-data-cell" style="border: var(--cell-border) ${outcomeBorder};">${layers}<span class="grid-cell-live-value">${formatCurrency(displayValue)}</span></div>`;
    }

    function portraitCellClass(html) {
        return html.replace(/class="grid-cell([^"]*)"/, 'class="grid-cell portrait-data-cell$1"');
    }

    function getDayPartPresentation(forecasts, actuals, startIdx, endExclusive, wallStartHour, wallEndHourExclusive, ctx) {
        const hourProgress = getCurrentHourProgress(ctx.openHour, ctx.hourCount, ctx.timeZone);
        const totalForecast = sumHourSlice(forecasts, startIdx, endExclusive);
        const totalActual = sumHourSlice(actuals, startIdx, endExclusive);
        const { hour, minute, second } = zoneHourMinuteSecond(ctx.timeZone);
        const nowHourFloat = hour + minute / 60 + second / 3600;
        const wallPct =
            Math.round(getWallClockPeriodProgress(wallStartHour, wallEndHourExclusive, ctx.timeZone) * 1000) / 10;

        if (nowHourFloat < wallStartHour) {
            return { phase: 'before', cellClass: '', liveLayersHtml: '', outcomeBorderColor: '' };
        }

        if (nowHourFloat >= wallEndHourExclusive) {
            const finalClass = totalForecast > 0 ? getActualCellClass(totalActual, totalForecast) : 'cell-green';
            const paceClass = totalForecast > 0 ? getPaceClass(totalActual, totalForecast, 1) : 'cell-green';
            const liveLayersHtml = buildLiveProgressLayersHtml(100, finalClass, paceClass);
            return {
                phase: 'after',
                cellClass: finalClass,
                liveLayersHtml,
                outcomeBorderColor: paceBorderMap[finalClass] || 'var(--blank-border)',
            };
        }

        let paceClass = 'cell-green';
        if (totalForecast > 0) {
            const expectedSoFar = getPeriodExpectedSoFarSlice(forecasts, startIdx, endExclusive, hourProgress);
            const actualSoFar = getPeriodActualSoFarSlice(actuals, startIdx, endExclusive, hourProgress);
            const ep = expectedSoFar / totalForecast;
            paceClass =
                expectedSoFar <= 0 ? 'cell-green' : getPaceClass(actualSoFar, totalForecast, ep);
        }

        const mainClass = totalForecast > 0 ? getActualCellClass(totalActual, totalForecast) : 'cell-green';
        const liveLayersHtml = buildLiveProgressLayersHtml(wallPct, mainClass, paceClass);
        return {
            phase: 'during',
            cellClass: '',
            liveLayersHtml,
            outcomeBorderColor: paceBorderMap[mainClass] || 'var(--blank-border)',
        };
    }

    function portraitSummaryItemStatusClass(pres, actual, forecast) {
        if (pres?.liveLayersHtml) return '';
        if (pres?.phase === 'before' || pres?.phase === 'during') return '';
        if (pres?.phase === 'after' && pres.cellClass) return pres.cellClass;
        if (Number(forecast) > 0) return getActualCellClass(actual, forecast);
        return 'cell-green';
    }

    function buildPortraitSummaryItem(label, actual, forecast, pres = null, extraClass = '') {
        const liveHtml = pres?.liveLayersHtml || '';
        const statusClass = portraitSummaryItemStatusClass(pres, actual, forecast);
        return `
            <div class="portrait-summary-item ${extraClass}">
                <div class="portrait-summary-item-label">${label}</div>
                <div class="portrait-summary-item-values ${statusClass}${liveHtml ? ' portrait-summary-item-values--live' : ''}">
                    ${liveHtml}
                    <div class="portrait-summary-item-amount">${formatCurrency(actual)} / ${formatCurrency(forecast)}</div>
                </div>
            </div>`;
    }

    function trimHourlyToTradingWindow(actual, forecast, openHour, closeHour) {
        const open = Number.isFinite(openHour) ? Math.trunc(openHour) : 10;
        const close = Number.isFinite(closeHour) && closeHour > open ? Math.trunc(closeHour) : open + 12;
        const a = Array.isArray(actual) ? actual : [];
        const f = Array.isArray(forecast) ? forecast : [];
        const sliceStart = Math.max(0, open - RAW_BASE_HOUR);
        const sliceEnd = Math.max(sliceStart, close - RAW_BASE_HOUR);
        return {
            actual: a.slice(sliceStart, sliceEnd),
            forecast: f.slice(sliceStart, sliceEnd),
        };
    }

    function resolveHourly(salesToday = {}) {
        let forecasts = Array.isArray(salesToday.forecastHourly) ? salesToday.forecastHourly : [];
        let actuals = Array.isArray(salesToday.actualHourly) ? salesToday.actualHourly : [];
        if (forecasts.length || actuals.length) {
            return { forecasts, actuals };
        }
        const trimmed = trimHourlyToTradingWindow(
            salesToday.rawActual ?? salesToday.actual,
            salesToday.rawForecast ?? salesToday.forecast,
            salesToday.openHour,
            salesToday.closeHour
        );
        return { forecasts: trimmed.forecast, actuals: trimmed.actual };
    }

    function buildContext(salesToday = {}) {
        const openHour = Number.isFinite(salesToday.openHour) ? Math.trunc(salesToday.openHour) : 10;
        const closeHour =
            Number.isFinite(salesToday.closeHour) && salesToday.closeHour > openHour
                ? Math.trunc(salesToday.closeHour)
                : openHour + 12;
        const hourCount = closeHour - openHour;
        const timeZone = String(salesToday.timeZone || DEFAULT_TZ).trim() || DEFAULT_TZ;
        const times = Array.from({ length: hourCount }, (_, i) => hourLabel(openHour + i));
        const partLunchEnd = clampInt(MEAL_SPLIT_HOUR - openHour, 0, hourCount);
        return {
            openHour,
            closeHour,
            hourCount,
            timeZone,
            times,
            partLunchEnd,
            lunchWallStart: openHour,
            lunchWallEndExclusive: clampInt(MEAL_SPLIT_HOUR, openHour, closeHour),
            dinnerWallStart: clampInt(MEAL_SPLIT_HOUR, openHour, closeHour),
        };
    }

    function buildMobileMealRow({ label, actual, forecast, pres }) {
        const liveHtml = pres?.liveLayersHtml || '';
        const statusClass = portraitSummaryItemStatusClass(pres, actual, forecast);
        return `
            <div class="mic-meal-total-row">
                <div class="mic-meal-total-label">${label}</div>
                <div class="mic-meal-total-bar ${statusClass}${liveHtml ? ' mic-meal-total-bar--live' : ''}">
                    ${liveHtml}
                    <span class="mic-meal-total-amount">${formatCurrency(actual)} <span class="mic-meal-total-sep">/</span> ${formatCurrency(forecast)}</span>
                </div>
            </div>`;
    }

    function computeMealSummaries(salesToday = {}) {
        const { forecasts, actuals } = resolveHourly(salesToday);
        const ctx = buildContext(salesToday);
        if (!forecasts.length && !actuals.length) return null;

        const lunchForecast = sumHourSlice(forecasts, 0, ctx.partLunchEnd);
        const lunchActual = sumHourSlice(actuals, 0, ctx.partLunchEnd);
        const dinnerForecast = sumHourSlice(forecasts, ctx.partLunchEnd, ctx.times.length);
        const dinnerActual = sumHourSlice(actuals, ctx.partLunchEnd, ctx.times.length);

        return {
            ctx,
            forecasts,
            actuals,
            summaries: [
                {
                    label: 'Lunch',
                    actual: lunchActual,
                    forecast: lunchForecast,
                    pres: getDayPartPresentation(
                        forecasts,
                        actuals,
                        0,
                        ctx.partLunchEnd,
                        ctx.lunchWallStart,
                        ctx.lunchWallEndExclusive,
                        ctx
                    ),
                },
                {
                    label: 'Dinner',
                    actual: dinnerActual,
                    forecast: dinnerForecast,
                    pres: getDayPartPresentation(
                        forecasts,
                        actuals,
                        ctx.partLunchEnd,
                        ctx.times.length,
                        ctx.dinnerWallStart,
                        ctx.closeHour,
                        ctx
                    ),
                },
            ],
        };
    }

    function renderMobileMealTotals(salesToday = {}) {
        const data = computeMealSummaries(salesToday);
        if (!data) {
            return '<p class="mic-mini-dashboard-empty">Waiting for sales data</p>';
        }
        return `
            <div class="mic-meal-totals" role="region" aria-label="Lunch and dinner totals">
                ${data.summaries.map((row) => buildMobileMealRow(row)).join('')}
            </div>`;
    }

    function renderPortraitGrid(salesToday = {}) {
        const data = computeMealSummaries(salesToday);
        if (!data) {
            return '<p class="mic-mini-dashboard-empty">Waiting for sales data</p>';
        }

        const { forecasts, actuals, ctx, summaries } = data;
        const hourProgress = getCurrentHourProgress(ctx.openHour, ctx.hourCount, ctx.timeZone);
        const hourRows = ctx.times
            .map((time, index) => {
                const forecastCell = buildHourlyDataCell({
                    index,
                    hourProgress,
                    forecast: forecasts[index],
                    actual: actuals[index],
                    displayValue: forecasts[index],
                    portraitPastLive: true,
                });
                const actualCell = buildHourlyDataCell({
                    index,
                    hourProgress,
                    forecast: forecasts[index],
                    actual: actuals[index],
                    displayValue: actuals[index],
                    portraitPastLive: true,
                });
                return `
                    <div class="grid-label portrait-hour-label">${time}</div>
                    ${actualCell}
                    ${forecastCell}`;
            })
            .join('');

        return `
            <div class="portrait-summary-box" role="region" aria-label="Lunch and dinner totals">
                ${summaries
                    .map((row) =>
                        buildPortraitSummaryItem(row.label, row.actual, row.forecast, row.pres)
                    )
                    .join('')}
            </div>
            <div class="grid-cell header-cell portrait-header portrait-header--time">Time</div>
            <div class="grid-cell header-cell portrait-header portrait-header--actual">Actual</div>
            <div class="grid-cell header-cell portrait-header portrait-header--forecast">Forecast</div>
            ${hourRows}`;
    }

    function renderMobileHourlyWindow(salesToday = {}, { before = 2, after = 1, allHours = false } = {}) {
        const data = computeMealSummaries(salesToday);
        if (!data) return '';

        const { forecasts, actuals, ctx } = data;
        const hourProgress = getCurrentHourProgress(ctx.openHour, ctx.hourCount, ctx.timeZone);
        const lastIndex = ctx.times.length - 1;
        let startIdx;
        let endIdx;
        if (allHours) {
            startIdx = 0;
            endIdx = ctx.times.length;
        } else {
            let focusIndex = hourProgress.hourIndex;
            if (focusIndex < 0) focusIndex = 0;
            if (focusIndex > lastIndex) focusIndex = lastIndex;
            startIdx = Math.max(0, focusIndex - before);
            endIdx = Math.min(ctx.times.length, focusIndex + after + 1);
        }
        const hourRows = ctx.times
            .slice(startIdx, endIdx)
            .map((time, offset) => {
                const index = startIdx + offset;
                const forecastCell = buildHourlyDataCell({
                    index,
                    hourProgress,
                    forecast: forecasts[index],
                    actual: actuals[index],
                    displayValue: forecasts[index],
                    portraitPastLive: true,
                });
                const actualCell = buildHourlyDataCell({
                    index,
                    hourProgress,
                    forecast: forecasts[index],
                    actual: actuals[index],
                    displayValue: actuals[index],
                    portraitPastLive: true,
                });
                const isCurrent = index === hourProgress.hourIndex;
                return `
                    <div class="mic-mobile-hour-row${isCurrent ? ' mic-mobile-hour-row--current' : ''}">
                        <div class="mic-mobile-hour-time">${time}</div>
                        ${actualCell}
                        ${forecastCell}
                    </div>`;
            })
            .join('');

        return `
            <div class="mic-mobile-hourly${allHours ? ' mic-mobile-hourly--scroll' : ''}" role="region" aria-label="Today's hourly sales">
                <div class="mic-mobile-hourly-head">
                    <span>Time</span>
                    <span>Actual</span>
                    <span>Forecast</span>
                </div>
                <div class="mic-mobile-hourly-body">
                    ${hourRows}
                </div>
            </div>`;
    }

    function getTradingHourCount(salesToday = {}) {
        return buildContext(salesToday).hourCount;
    }

    window.MicMiniDashboard = {
        renderPortraitGrid,
        renderMobileMealTotals,
        renderMobileHourlyWindow,
        resolveHourly,
        trimHourlyToTradingWindow,
        getTradingHourCount,
    };
})();
