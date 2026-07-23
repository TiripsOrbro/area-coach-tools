const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../paths');
const { sendBugReportEmail } = require('./bugReportEmail');

const DATA_FILE = path.join(paths.dashboard.data, 'bug-reports.json');
const PHOTOS_DIR = path.join(paths.dashboard.data, 'bug-reports', 'photos');

const MAX_TITLE_LENGTH = 200;
const MAX_DETAILS_LENGTH = 8000;
const MAX_PHOTOS_PER_BUG = 5;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_BUGS = 500;

const DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i;

function emptyState() {
    return { bugs: [] };
}

function readState() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return emptyState();
        return { bugs: Array.isArray(parsed.bugs) ? parsed.bugs : [] };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[BugReports] Failed to read state file:', error.message);
        }
        return emptyState();
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function photoDirForBug(bugId) {
    return path.join(PHOTOS_DIR, String(bugId || '').trim());
}

function parsePhotoInput(raw, index) {
    const value = String(raw || '').trim();
    const match = value.match(DATA_URL_RE);
    if (!match) return { ok: false, error: `Photo ${index + 1} is not a supported image.` };
    const contentType = match[1].toLowerCase().replace('jpg', 'jpeg');
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length) return { ok: false, error: `Photo ${index + 1} is empty.` };
    if (buffer.length > MAX_PHOTO_BYTES) {
        return { ok: false, error: `Photo ${index + 1} is too large (max ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB).` };
    }
    const ext =
        contentType.includes('png') ? 'png'
        : contentType.includes('webp') ? 'webp'
        : contentType.includes('gif') ? 'gif'
        : 'jpg';
    return {
        ok: true,
        photo: {
            id: crypto.randomUUID(),
            filename: `photo-${index + 1}.${ext}`,
            contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
            buffer,
        },
    };
}

function savePhotoFiles(bugId, photos) {
    const dir = photoDirForBug(bugId);
    fs.mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const photo of photos) {
        const filePath = path.join(dir, `${photo.id}${path.extname(photo.filename) || '.jpg'}`);
        fs.writeFileSync(filePath, photo.buffer);
        saved.push({
            id: photo.id,
            filename: photo.filename,
            contentType: photo.contentType,
        });
    }
    return saved;
}

function deleteBugPhotos(bugId) {
    const dir = photoDirForBug(bugId);
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}

function readPhotoFile(bugId, photoId) {
    const dir = photoDirForBug(bugId);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir);
    const match = files.find((name) => name.startsWith(String(photoId)));
    if (!match) return null;
    const filePath = path.join(dir, match);
    const content = fs.readFileSync(filePath);
    const ext = path.extname(match).toLowerCase();
    const contentType =
        ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
        : 'image/jpeg';
    return { content, contentType, filePath };
}

function normalizeBug(row, viewerUsername = '') {
    const upvotes = Array.isArray(row.upvotes) ? row.upvotes.map(String) : [];
    const viewer = String(viewerUsername || '').trim();
    return {
        id: row.id,
        title: String(row.title || '').slice(0, MAX_TITLE_LENGTH),
        details: String(row.details || '').slice(0, MAX_DETAILS_LENGTH),
        fixed: Boolean(row.fixed),
        createdAt: row.createdAt || null,
        fixedAt: row.fixedAt || null,
        submittedBy: String(row.submittedBy || '').trim(),
        submittedByName: String(row.submittedByName || row.submittedBy || '').trim(),
        upvoteCount: upvotes.length,
        upvotedByViewer: viewer ? upvotes.includes(viewer) : false,
        photos: Array.isArray(row.photos)
            ? row.photos.map((photo) => ({
                  id: photo.id,
                  filename: photo.filename,
                  contentType: photo.contentType,
              }))
            : [],
    };
}

function sortBugs(bugs) {
    const open = bugs
        .filter((row) => !row.fixed)
        .sort((a, b) => {
            const voteDiff = (b.upvoteCount || 0) - (a.upvoteCount || 0);
            if (voteDiff !== 0) return voteDiff;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });
    const fixed = bugs
        .filter((row) => row.fixed)
        .sort((a, b) => new Date(b.fixedAt || b.createdAt) - new Date(a.fixedAt || a.createdAt));
    return [...open, ...fixed];
}

function listBugReports(viewerUsername = '') {
    const state = readState();
    const bugs = state.bugs.map((row) => normalizeBug(row, viewerUsername));
    return sortBugs(bugs);
}

function findBug(state, id) {
    return state.bugs.find((row) => row.id === id) || null;
}

async function addBugReport({ title, details, photos, username, displayName }) {
    const trimmedTitle = String(title || '').trim();
    if (trimmedTitle.length < 3) {
        return { ok: false, error: 'Please enter a title of at least a few characters.' };
    }
    if (trimmedTitle.length > MAX_TITLE_LENGTH) {
        return { ok: false, error: `Title is too long (max ${MAX_TITLE_LENGTH} characters).` };
    }

    const photoInputs = Array.isArray(photos) ? photos.slice(0, MAX_PHOTOS_PER_BUG) : [];
    const parsedPhotos = [];
    for (let i = 0; i < photoInputs.length; i += 1) {
        const parsed = parsePhotoInput(photoInputs[i], i);
        if (!parsed.ok) return parsed;
        parsedPhotos.push(parsed.photo);
    }

    const state = readState();
    if (state.bugs.length >= MAX_BUGS) {
        return { ok: false, error: 'Bug report limit reached. Contact support.' };
    }

    const bug = {
        id: crypto.randomUUID(),
        title: trimmedTitle,
        details: String(details || '').slice(0, MAX_DETAILS_LENGTH),
        fixed: false,
        createdAt: new Date().toISOString(),
        fixedAt: null,
        submittedBy: String(username || '').trim(),
        submittedByName: String(displayName || username || '').trim(),
        upvotes: [],
        photos: [],
    };

    if (parsedPhotos.length) {
        bug.photos = savePhotoFiles(bug.id, parsedPhotos);
    }

    state.bugs.push(bug);
    writeState(state);

    const normalized = normalizeBug(bug, username);
    try {
        await sendBugReportEmail({
            bug: normalized,
            reporterName: bug.submittedByName,
            reporterUsername: bug.submittedBy,
            photoAttachments: parsedPhotos.map((photo) => ({
                filename: photo.filename,
                content: photo.buffer,
                contentType: photo.contentType,
            })),
        });
    } catch (error) {
        console.warn('[BugReports] Report email failed:', error.message);
    }

    return { ok: true, bug: normalized, bugs: listBugReports(username) };
}

function toggleBugUpvote(id, username) {
    const user = String(username || '').trim();
    if (!user) return { ok: false, error: 'Sign in to upvote bugs.' };

    const state = readState();
    const bug = findBug(state, id);
    if (!bug) return { ok: false, error: 'Bug report not found.' };
    if (bug.fixed) return { ok: false, error: 'Fixed bugs cannot be upvoted.' };

    const upvotes = Array.isArray(bug.upvotes) ? [...bug.upvotes] : [];
    const index = upvotes.indexOf(user);
    if (index === -1) upvotes.push(user);
    else upvotes.splice(index, 1);
    bug.upvotes = upvotes;
    writeState(state);

    return {
        ok: true,
        bug: normalizeBug(bug, user),
        bugs: listBugReports(user),
    };
}

function updateBugReport(id, updates = {}, viewerUsername = '') {
    const state = readState();
    const bug = findBug(state, id);
    if (!bug) return { ok: false, error: 'Bug report not found.' };

    if (typeof updates.fixed === 'boolean') {
        bug.fixed = updates.fixed;
        bug.fixedAt = bug.fixed ? new Date().toISOString() : null;
        if (bug.fixed) {
            deleteBugPhotos(bug.id);
            bug.photos = [];
        }
    }

    writeState(state);
    return {
        ok: true,
        bug: normalizeBug(bug, viewerUsername),
        bugs: listBugReports(viewerUsername),
    };
}

function getBugPhoto(bugId, photoId) {
    const state = readState();
    const bug = findBug(state, bugId);
    if (!bug || bug.fixed) return { ok: false, error: 'Photo not found.' };
    const photo = (bug.photos || []).find((row) => row.id === photoId);
    if (!photo) return { ok: false, error: 'Photo not found.' };
    const file = readPhotoFile(bugId, photoId);
    if (!file) return { ok: false, error: 'Photo file missing.' };
    return { ok: true, content: file.content, contentType: file.contentType };
}

module.exports = {
    listBugReports,
    addBugReport,
    toggleBugUpvote,
    updateBugReport,
    getBugPhoto,
};
