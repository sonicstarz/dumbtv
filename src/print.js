import PDFDocument from 'pdfkit';
import { db } from './db.js';
import { nowOn } from './schedule/resolver.js';
import { DAY, MINUTE } from './util/time.js';

/**
 * The printable weekly guide. One landscape page per day: time down the left,
 * channels across the top, a program named in the slot it starts — the classic
 * newspaper TV grid. Premieres get a NEW tag; blackouts read "off air". Rendered
 * straight from the programs table, so a page taped to the fridge is the literal
 * truth of what will air. No LLM anywhere near it.
 */

const AMBER = '#c08a1e';
const NAVY = '#2b3a8f';
const DIM = '#8a8a8a';
const TALLY = '#c0342b';

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayStartOf(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

export function buildSchedulePdf({ from = Date.now(), days = 7, channelIds = null } = {}) {
  // Tiny bottom margin so pdfkit never auto-inserts a page when a low row's text
  // reaches the bottom — we lay the grid out by hand, one page per day.
  const doc = new PDFDocument({ size: 'letter', layout: 'landscape', margins: { top: 36, bottom: 6, left: 36, right: 36 } });

  let channels = db.prepare('SELECT id, number, name FROM channels WHERE enabled = 1 ORDER BY number').all();
  if (channelIds && channelIds.length) channels = channels.filter((c) => channelIds.includes(c.id));

  const pageW = 792, pageH = 612, mL = 36, mR = 36;
  const timeW = 52;
  const gridX = mL + timeW;
  const colW = channels.length ? (pageW - mR - gridX) / channels.length : 0;
  const start = dayStartOf(from);
  const nRows = 48;                 // 30-minute slots across the day

  for (let d = 0; d < days; d++) {
    if (d > 0) doc.addPage();
    const dayStart = start + d * DAY;

    doc.fillColor(AMBER).font('Helvetica-Bold').fontSize(18).text('CATHODE', mL, 22);
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(12)
      .text(new Date(dayStart).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), mL + 118, 28);

    // channel header
    const headerY = 48;
    doc.font('Helvetica-Bold').fontSize(8.5);
    channels.forEach((ch, i) => {
      const x = gridX + i * colW;
      doc.fillColor(NAVY).rect(x, headerY, colW - 1.5, 16).fill();
      doc.fillColor('#fff').text(`${String(ch.number).padStart(2, '0')}  ${ch.name}`, x + 4, headerY + 4.5, { width: colW - 8, ellipsis: true });
    });

    const rowsTop = headerY + 16;
    const rowH = (pageH - rowsTop - 22) / nRows;
    const prevStart = new Array(channels.length).fill(NaN);

    for (let r = 0; r < nRows; r++) {
      const slotT = dayStart + r * 30 * MINUTE;
      const y = rowsTop + r * rowH;
      const onHour = r % 2 === 0;
      doc.moveTo(mL, y).lineTo(pageW - mR, y).strokeColor(onHour ? '#cfcfcf' : '#ececec').lineWidth(onHour ? 0.7 : 0.4).stroke();
      doc.fillColor(onHour ? '#111' : DIM).font(onHour ? 'Helvetica-Bold' : 'Helvetica').fontSize(onHour ? 8 : 7)
        .text(clock(slotT), mL, y + 1.5, { width: timeW - 5, align: 'right' });

      channels.forEach((ch, i) => {
        const x = gridX + i * colW;
        const p = nowOn(ch.id, slotT + 1000);
        if (!p) { prevStart[i] = NaN; return; }
        // Name a program the first slot it appears; blank its continuation.
        if (p.startUtc === prevStart[i]) return;
        prevStart[i] = p.startUtc;
        if (p.kind === 'offair') {
          doc.fillColor(DIM).font('Helvetica-Oblique').fontSize(7).text('off air', x + 4, y + 1.5, { width: colW - 8, ellipsis: true, lineBreak: false });
          return;
        }
        const isNew = p.airingNo === 1;
        const ep = p.seasonNo != null && p.episodeNo != null ? ` S${p.seasonNo}E${p.episodeNo}` : '';
        const label = `${isNew ? 'NEW · ' : ''}${p.title}${p.subtitle ? ' — ' + p.subtitle : ''}${ep}`;
        doc.font(isNew ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.3)
          .fillColor(isNew ? TALLY : '#111')
          .text(label, x + 4, y + 1.5, { width: colW - 8, height: rowH, ellipsis: true, lineBreak: false });
      });
    }

    // column separators
    channels.forEach((ch, i) => {
      const x = gridX + i * colW;
      doc.moveTo(x, headerY).lineTo(x, pageH - 22).strokeColor('#cfcfcf').lineWidth(0.5).stroke();
    });
    doc.fillColor(DIM).font('Helvetica').fontSize(7)
      .text('Cathode — what’s on is what’s on', mL, pageH - 18);
  }

  doc.end();
  return doc;
}
