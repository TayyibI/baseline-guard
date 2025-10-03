/**
 * Simple utility to convert a date string to a Date object.
 * @param {string} dateString - The date string to parse.
 * @returns {Date} - The parsed Date object.
 */
function toDate(dateString) {
    return new Date(dateString);
}

module.exports = {
    toDate
};