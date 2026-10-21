// Adds up the client's own processing time between ticks.
let spent = 0;
let clock = () => performance.now();

export function setClock(now) {
  clock = now;
}

// Wraps a handler so the time it takes is counted.
export function timed(fn) {
  return (...args) => {
    const t0 = clock();
    try {
      return fn(...args);
    } finally {
      spent += clock() - t0;
    }
  };
}

// Returns the time counted since the last call, rounded to 0.001 ms, and resets it.
export function takeSpent() {
  const ms = Math.round(spent * 1000) / 1000;
  spent = 0;
  return ms;
}
