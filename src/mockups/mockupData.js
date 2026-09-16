// Hardcoded figures for the stats-layout mockup. Throwaway — delete with the
// rest of src/mockups once a layout is chosen.

export const ALL_SONGS_TODAY_MINUTES = 11;

export const WHOLE_SONG = {
  label: "Pastorale No. 3",
  passesToday: 10,
  passesAllTime: 21,
  timeTodayMin: 4,
  timeAllTimeMin: 47,
};

// Six snippets: two reading all zeros, one archived, one over an hour of total
// practice, so every formatting edge is visible at once.
export const SNIPPETS = [
  {
    id: "s1",
    title: "Measures 1-2 RH No Rest",
    archived: false,
    passesToday: 6,
    passesAllTime: 41,
    timeTodayMin: 12,
    timeAllTimeMin: 65, // over an hour
  },
  {
    id: "s2",
    title: "Measures 5-8 Both Rest: 2",
    archived: false,
    passesToday: 4,
    passesAllTime: 12,
    timeTodayMin: 9,
    timeAllTimeMin: 23,
  },
  {
    id: "s3",
    title: "Measures 12-16 LH No Rest",
    archived: false,
    passesToday: 0,
    passesAllTime: 9,
    timeTodayMin: 0,
    timeAllTimeMin: 18,
  },
  {
    id: "s4",
    title: "Measures 20-24 Both No Rest",
    archived: false,
    passesToday: 0,
    passesAllTime: 0,
    timeTodayMin: 0,
    timeAllTimeMin: 0,
  },
  {
    id: "s5",
    title: "Measures 30-31 RH No Rest",
    archived: false,
    passesToday: 0,
    passesAllTime: 0,
    timeTodayMin: 0,
    timeAllTimeMin: 0,
  },
  {
    id: "s6",
    title: "Measures 9-11 Both No Rest",
    archived: true,
    passesToday: 0,
    passesAllTime: 14,
    timeTodayMin: 0,
    timeAllTimeMin: 31,
  },
];

// "4 min", "1 h 5 min", "0 min" — units only, no other abbreviation.
export function mins(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}
