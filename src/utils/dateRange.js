// Resolves a { from, to } YYYY-MM-DD date range from either an explicit from/to
// query pair or a named period (today|week|month|year|all). Used wherever an
// admin/manager filters transactions or reports by date.
function resolveDateRange(query) {
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const now = new Date();

  if (query.from || query.to) {
    return { from: query.from || null, to: query.to || null };
  }

  const period = (query.period || 'all').toLowerCase();
  let from = null;
  if (period === 'today') from = ymd(now);
  else if (period === 'week') { const d = new Date(now); d.setDate(now.getDate() - 6); from = ymd(d); }
  else if (period === 'month') from = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-01';
  else if (period === 'year') from = now.getFullYear() + '-01-01';
  // 'all' -> no bounds

  return { from, to: null };
}

module.exports = { resolveDateRange };
