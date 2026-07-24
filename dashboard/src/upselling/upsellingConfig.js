/** Shared Melbourne time zone for dashboard sales / SSSG helpers. */
const TIME_ZONE = String(process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();

module.exports = {
    TIME_ZONE,
};
