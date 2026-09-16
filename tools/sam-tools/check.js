import fs from 'node:fs';

const a = JSON.parse(fs.readFileSync('scientist.json', 'utf8'));
const b = JSON.parse(fs.readFileSync(
  'C:/Users/Alex/Downloads/rebuild/The Scientist - Coldplay.json', 'utf8'));

const show = (evs) => (evs || []).map(e =>
  `${e.duration}${e.tuplet ? 'T' : ''}:${(e.notes || []).map(n => n.name).join('+') || 'rest'}`
).join(' ');

let n = 0;
a.measures.forEach((ma, i) => {
  const mb = b.measures[i];
  for (const hand of ['rh', 'lh']) {
    if (JSON.stringify(ma[hand]) !== JSON.stringify(mb[hand])) {
      n++;
      if (n <= 12) {
        console.log(`m${ma.number} ${hand}`);
        console.log(`  old: ${show(ma[hand])}`);
        console.log(`  new: ${show(mb[hand])}`);
      }
    }
  }
});
console.log(`\n${n} hand(s) differ`);

// also check whether anything outside the notes moved
for (const k of ['fifths', 'key', 'defaultBpm', 'formatVersion']) {
  if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    console.log(`song-level ${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
}