const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../paths');
const { sendFeatureRequestEmail } = require('./bugReportEmail');

const DATA_FILE = path.join(paths.dashboard.data, 'feature-requests.json');

const DEFAULT_CATEGORIES = [
    { id: 'general', label: 'General' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'audits', label: 'Audits' },
    { id: 'admin', label: 'Admin' },
    { id: 'operations', label: 'Operations' },
];

const FEATURE_REQUEST_PRIORITIES = [
    { id: 'low', label: 'Low', rank: 1 },
    { id: 'normal', label: 'Normal', rank: 2 },
    { id: 'high', label: 'High', rank: 3 },
    { id: 'urgent', label: 'Urgent', rank: 4 },
];

const ROADMAP_STATUSES = [
    { id: 'not_started', label: 'Not Started' },
    { id: 'started', label: 'Started' },
    { id: 'testing', label: 'Testing' },
    { id: 'debugging', label: 'Debugging' },
    { id: 'finished', label: 'Finished' },
];

const PRIORITY_IDS = new Set(FEATURE_REQUEST_PRIORITIES.map((row) => row.id));
const PRIORITY_RANK = Object.fromEntries(FEATURE_REQUEST_PRIORITIES.map((row) => [row.id, row.rank]));
const ROADMAP_STATUS_IDS = new Set(ROADMAP_STATUSES.map((row) => row.id));

const MAX_DETAILS_LENGTH = 5000;
const MAX_MILESTONES = 50;
const MAX_MILESTONE_TEXT = 500;
const MAX_CATEGORIES = 30;
const MAX_CATEGORY_LABEL = 40;

function emptyState() {
    return { categories: DEFAULT_CATEGORIES.map((row) => ({ ...row })), requests: [] };
}

function readState() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return emptyState();
        const state = {
            categories: Array.isArray(parsed.categories) ? parsed.categories : DEFAULT_CATEGORIES.map((row) => ({ ...row })),
            requests: Array.isArray(parsed.requests) ? parsed.requests : [],
        };
        state.categories = normalizeCategories(state.categories);
        if (!state.categories.length) {
            state.categories = DEFAULT_CATEGORIES.map((row) => ({ ...row }));
        }
        return state;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[FeatureRequests] Failed to read state file:', error.message);
        }
        return emptyState();
    }
}

function writeState(state) {
    try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        throw new Error(`Could not save feature requests: ${error.message}`);
    }
}

function slugFromLabel(label) {
    const base = String(label || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return base || 'tab';
}

function normalizeCategories(categories) {
    const seen = new Set();
    const out = [];
    for (const row of categories || []) {
        const label = String(row?.label || '').trim().slice(0, MAX_CATEGORY_LABEL);
        let id = String(row?.id || slugFromLabel(label)).trim().toLowerCase();
        if (!label || id === 'all' || id === 'done' || id === 'unassigned') continue;
        if (!/^[a-z0-9-]+$/.test(id)) id = slugFromLabel(label);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, label, hidden: Boolean(row?.hidden) });
    }
    return out.slice(0, MAX_CATEGORIES);
}

function categoryIdsFromState(state, options = {}) {
    const includeHidden = Boolean(options.includeHidden);
    const rows = (state?.categories || []).filter((row) => includeHidden || !row.hidden);
    return new Set(rows.map((row) => row.id));
}

function unassignRequestsFromCategory(state, categoryId) {
    let count = 0;
    for (const request of state.requests || []) {
        if (request.category === categoryId) {
            delete request.category;
            count += 1;
        }
    }
    return count;
}

function normalizeCategory(value, state) {
    if (value === null || value === undefined || value === '' || value === 'unassigned' || value === 'none') {
        return null;
    }
    const id = String(value || '').trim().toLowerCase();
    const ids = categoryIdsFromState(state || readState());
    return ids.has(id) ? id : null;
}

function normalizePriority(value) {
    const id = String(value || 'normal').trim().toLowerCase();
    return PRIORITY_IDS.has(id) ? id : 'normal';
}

function priorityRank(priorityId) {
    return PRIORITY_RANK[normalizePriority(priorityId)] || PRIORITY_RANK.normal;
}

function normalizeRoadmapStatus(value) {
    const id = String(value || 'not_started').trim().toLowerCase();
    return ROADMAP_STATUS_IDS.has(id) ? id : 'not_started';
}

function nextRoadmapOrder(state) {
    let max = 0;
    for (const row of state.requests || []) {
        if (row.onRoadmap && typeof row.roadmapOrder === 'number' && row.roadmapOrder > max) {
            max = row.roadmapOrder;
        }
    }
    return max + 1;
}

function normalizeMilestones(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((row) => ({
            id: String(row?.id || crypto.randomUUID()),
            text: String(row?.text || '').trim().slice(0, MAX_MILESTONE_TEXT),
            completed: Boolean(row?.completed),
        }))
        .filter((row) => row.text.length > 0)
        .slice(0, MAX_MILESTONES);
}

function requestScore(row) {
    const upvotes = Array.isArray(row?.upvotes) ? row.upvotes.length : 0;
    const downvotes = Array.isArray(row?.downvotes) ? row.downvotes.length : 0;
    return upvotes - downvotes;
}

function normalizeRequest(row, state, viewerUsername = '') {
    if (!row || typeof row !== 'object') return row;
    const category = normalizeCategory(row.category, state);
    const upvotes = Array.isArray(row.upvotes) ? row.upvotes.map(String) : [];
    const downvotes = Array.isArray(row.downvotes) ? row.downvotes.map(String) : [];
    const viewer = String(viewerUsername || '').trim();
    const onRoadmap = Boolean(row.onRoadmap);
    const normalized = {
        ...row,
        priority: normalizePriority(row.priority),
        details: String(row.details || '').slice(0, MAX_DETAILS_LENGTH),
        milestones: normalizeMilestones(row.milestones),
        onRoadmap,
        roadmapStatus: normalizeRoadmapStatus(row.roadmapStatus),
        upvoteCount: upvotes.length,
        downvoteCount: downvotes.length,
        score: upvotes.length - downvotes.length,
        upvotedByViewer: viewer ? upvotes.includes(viewer) : false,
        downvotedByViewer: viewer ? downvotes.includes(viewer) : false,
    };
    if (onRoadmap && typeof row.roadmapOrder === 'number') {
        normalized.roadmapOrder = row.roadmapOrder;
    } else {
        delete normalized.roadmapOrder;
    }
    if (onRoadmap && row.roadmapAddedAt) {
        normalized.roadmapAddedAt = row.roadmapAddedAt;
    } else {
        delete normalized.roadmapAddedAt;
    }
    if (category) {
        normalized.category = category;
    } else {
        delete normalized.category;
    }
    delete normalized.upvotes;
    delete normalized.downvotes;
    return normalized;
}

function sortRequests(requests) {
    const active = requests
        .filter((row) => !row.completed)
        .sort((a, b) => {
            const scoreDiff = requestScore(b) - requestScore(a);
            if (scoreDiff !== 0) return scoreDiff;
            const rankDiff = priorityRank(b.priority) - priorityRank(a.priority);
            if (rankDiff !== 0) return rankDiff;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });
    const done = requests
        .filter((row) => row.completed)
        .sort((a, b) => new Date(a.completedAt || 0) - new Date(b.completedAt || 0));
    return [...active, ...done];
}

function listFeatureRequestCategories(options = {}) {
    const state = readState();
    const includeHidden = Boolean(options.includeHidden);
    return state.categories
        .filter((row) => includeHidden || !row.hidden)
        .map((row) => {
            const out = { id: row.id, label: row.label };
            if (row.hidden) out.hidden = true;
            return out;
        });
}

function listFeatureRequestPriorities() {
    return FEATURE_REQUEST_PRIORITIES.map((row) => ({ ...row }));
}

function listRoadmapStatuses() {
    return ROADMAP_STATUSES.map((row) => ({ ...row }));
}

function listFeatureRequests(viewerUsername = '') {
    const state = readState();
    return sortRequests(state.requests.map((row) => normalizeRequest(row, state, viewerUsername)));
}

function addFeatureRequestCategory(label) {
    const trimmed = String(label || '').trim().slice(0, MAX_CATEGORY_LABEL);
    if (trimmed.length < 2) {
        return { ok: false, error: 'Tab name must be at least 2 characters.' };
    }

    const state = readState();
    if (state.categories.length >= MAX_CATEGORIES) {
        return { ok: false, error: `You can have at most ${MAX_CATEGORIES} tabs.` };
    }

    const ids = categoryIdsFromState(state, { includeHidden: true });
    const existingIndex = state.categories.findIndex(
        (row) => row.label.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (existingIndex !== -1) {
        const existing = state.categories[existingIndex];
        if (!existing.hidden) {
            return { ok: false, error: 'A tab with that name already exists.' };
        }
        delete existing.hidden;
        try {
            writeState(state);
        } catch (error) {
            existing.hidden = true;
            return { ok: false, error: error.message };
        }
        return {
            ok: true,
            category: { id: existing.id, label: existing.label },
            categories: listFeatureRequestCategories(),
        };
    }

    let id = slugFromLabel(trimmed);
    if (id === 'all' || id === 'done' || id === 'unassigned') id = `${id}-tab`;
    let suffix = 2;
    while (ids.has(id)) {
        id = `${slugFromLabel(trimmed)}-${suffix++}`;
    }

    const category = { id, label: trimmed };
    state.categories.push(category);
    try {
        writeState(state);
    } catch (error) {
        state.categories.pop();
        return { ok: false, error: error.message };
    }
    return { ok: true, category, categories: listFeatureRequestCategories() };
}

function findCategoryIndex(state, categoryId) {
    const id = String(categoryId || '').trim().toLowerCase();
    if (!id || id === 'all' || id === 'done' || id === 'unassigned') return -1;
    return state.categories.findIndex((row) => row.id === id);
}

function hideFeatureRequestCategory(categoryId) {
    const state = readState();
    const index = findCategoryIndex(state, categoryId);
    if (index === -1) {
        return { ok: false, error: 'Tab not found.' };
    }
    const category = state.categories[index];
    if (category.hidden) {
        return { ok: false, error: 'Tab is already hidden.' };
    }
    category.hidden = true;
    const unassignedCount = unassignRequestsFromCategory(state, category.id);
    writeState(state);
    return {
        ok: true,
        category: { id: category.id, label: category.label, hidden: true },
        categories: listFeatureRequestCategories(),
        requests: listFeatureRequests(),
        unassignedCount,
    };
}

function deleteFeatureRequestCategory(categoryId) {
    const state = readState();
    const index = findCategoryIndex(state, categoryId);
    if (index === -1) {
        return { ok: false, error: 'Tab not found.' };
    }
    const category = state.categories[index];
    const unassignedCount = unassignRequestsFromCategory(state, category.id);
    state.categories.splice(index, 1);
    writeState(state);
    return {
        ok: true,
        category: { id: category.id, label: category.label },
        categories: listFeatureRequestCategories(),
        requests: listFeatureRequests(),
        unassignedCount,
    };
}

async function addFeatureRequest({ text, username, displayName, category, details }) {
    const trimmed = String(text || '').trim();
    if (trimmed.length < 3) {
        return { ok: false, error: 'Please enter a title of at least a few characters.' };
    }
    if (trimmed.length > 2000) {
        return { ok: false, error: 'Title is too long (max 2000 characters).' };
    }

    const state = readState();
    const normalizedCategory = normalizeCategory(category, state);
    const request = {
        id: crypto.randomUUID(),
        text: trimmed,
        priority: 'normal',
        details: String(details || '').slice(0, MAX_DETAILS_LENGTH),
        milestones: [],
        upvotes: [],
        downvotes: [],
        completed: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
        submittedBy: String(username || '').trim(),
        submittedByName: String(displayName || username || '').trim(),
    };
    if (normalizedCategory) request.category = normalizedCategory;
    state.requests.push(request);
    writeState(state);

    const normalized = normalizeRequest(request, state, username);
    try {
        await sendFeatureRequestEmail({
            request: normalized,
            reporterName: request.submittedByName,
            reporterUsername: request.submittedBy,
        });
    } catch (error) {
        console.warn('[FeatureRequests] Report email failed:', error.message);
    }

    return { ok: true, request: normalized, requests: listFeatureRequests(username) };
}

function applyVote(request, username, direction) {
    const user = String(username || '').trim();
    if (!user) return;
    const upvotes = Array.isArray(request.upvotes) ? [...request.upvotes] : [];
    const downvotes = Array.isArray(request.downvotes) ? [...request.downvotes] : [];
    const upIdx = upvotes.indexOf(user);
    const downIdx = downvotes.indexOf(user);

    if (direction === 'up') {
        if (upIdx !== -1) upvotes.splice(upIdx, 1);
        else {
            if (downIdx !== -1) downvotes.splice(downIdx, 1);
            upvotes.push(user);
        }
    } else if (direction === 'down') {
        if (downIdx !== -1) downvotes.splice(downIdx, 1);
        else {
            if (upIdx !== -1) upvotes.splice(upIdx, 1);
            downvotes.push(user);
        }
    }

    request.upvotes = upvotes;
    request.downvotes = downvotes;
}

function toggleFeatureRequestVote(id, username, direction) {
    const user = String(username || '').trim();
    if (!user) return { ok: false, error: 'Sign in to vote on feature requests.' };
    if (direction !== 'up' && direction !== 'down') {
        return { ok: false, error: 'Invalid vote direction.' };
    }

    const state = readState();
    const item = state.requests.find((row) => row.id === id);
    if (!item) return { ok: false, error: 'Feature request not found.' };
    if (item.completed) return { ok: false, error: 'Completed requests cannot be voted on.' };

    applyVote(item, user, direction);
    writeState(state);

    return {
        ok: true,
        request: normalizeRequest(item, state, user),
        requests: listFeatureRequests(user),
        categories: listFeatureRequestCategories(),
    };
}

function updateFeatureRequest(id, updates = {}, viewerUsername = '') {
    const state = readState();
    const item = state.requests.find((row) => row.id === id);
    if (!item) {
        return { ok: false, error: 'Feature request not found.' };
    }

    if (typeof updates.completed === 'boolean') {
        item.completed = updates.completed;
        item.completedAt = item.completed ? new Date().toISOString() : null;
        if (item.completed && item.onRoadmap) {
            item.roadmapStatus = 'finished';
        } else if (!item.completed && item.onRoadmap) {
            item.roadmapStatus = 'not_started';
        }
    }
    if (typeof updates.onRoadmap === 'boolean') {
        if (updates.onRoadmap) {
            item.onRoadmap = true;
            item.roadmapOrder = nextRoadmapOrder(state);
            item.roadmapAddedAt = new Date().toISOString();
            item.roadmapStatus = 'not_started';
            item.completed = false;
            item.completedAt = null;
        } else {
            item.onRoadmap = false;
            delete item.roadmapOrder;
            delete item.roadmapAddedAt;
        }
    }
    if (updates.roadmapStatus !== undefined) {
        item.roadmapStatus = normalizeRoadmapStatus(updates.roadmapStatus);
        if (item.roadmapStatus === 'finished') {
            item.completed = true;
            item.completedAt = item.completedAt || new Date().toISOString();
        }
    }
    if (updates.category !== undefined) {
        const normalizedCategory = normalizeCategory(updates.category, state);
        if (normalizedCategory) {
            item.category = normalizedCategory;
        } else {
            delete item.category;
        }
    }
    if (updates.details !== undefined) {
        item.details = String(updates.details || '').slice(0, MAX_DETAILS_LENGTH);
    }
    if (updates.milestones !== undefined) {
        item.milestones = normalizeMilestones(updates.milestones);
    }
    if (updates.priority !== undefined) {
        item.priority = normalizePriority(updates.priority);
    }

    writeState(state);
    return {
        ok: true,
        request: normalizeRequest(item, state, viewerUsername),
        requests: listFeatureRequests(viewerUsername),
        categories: listFeatureRequestCategories(),
    };
}

module.exports = {
    DEFAULT_CATEGORIES,
    FEATURE_REQUEST_PRIORITIES,
    ROADMAP_STATUSES,
    listFeatureRequestCategories,
    listFeatureRequestPriorities,
    listRoadmapStatuses,
    listFeatureRequests,
    addFeatureRequestCategory,
    hideFeatureRequestCategory,
    deleteFeatureRequestCategory,
    addFeatureRequest,
    toggleFeatureRequestVote,
    updateFeatureRequest,
};
