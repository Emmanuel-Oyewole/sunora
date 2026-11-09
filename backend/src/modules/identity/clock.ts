/** Source of "now". Injected so expiry and cooldown logic can be tested without real time. */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
