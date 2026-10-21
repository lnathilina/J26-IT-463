// Placeholder probe questions about the demo page itself.
const ITEMS = [
  { text: 'What colour is the moving bar in the video placeholder?', options: ['Red', 'Blue', 'Green', 'Black'], correct: 2 },
  { text: 'What does the video placeholder show under its title?', options: ['A slide number', 'The date', 'Seconds counting up', 'Nothing'], correct: 3 },
  { text: 'Which button ends the session?', options: ['Stop (ends the session)', 'Start', 'Export JSON Lines', 'There is none'], correct: 1 },
];

export function makeDemoBank(segmentMs) {
  return {
    version: 'demo-placeholder-1',
    segmentAt(offsetMs) {
      const n = Math.floor(offsetMs / segmentMs);
      return { id: `demo-s${n}`, items: ITEMS.map((item, i) => ({ ...item, id: `DEMO-S${n}-Q${i + 1}` })) };
    },
  };
}
