/**
 * `fleet qualify`'s PLAYLIST: every qualification test, in the order a window
 * runs them (wave bootcamp2). Its own module because each test imports the
 * bars from qualify-registry.mjs; the registry importing the tests back would
 * be a cycle that reads QUALIFY_BARS before it is initialised.
 *
 * ORDER MATTERS. The concurrency ramp heats the node and fills its page cache,
 * so anything that measures an idle baseline runs before it.
 */
import { test as concurrencyRamp } from './qualify-concurrency.mjs';

export const QUALIFY_TESTS = Object.freeze([concurrencyRamp]);
