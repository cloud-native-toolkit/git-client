
export function isString(value: any): value is string {
  return value && typeof value === 'string';
}

export const timeTextToMilliseconds = (waitText: string): number => {
  if (!waitText) {
    return 0
  }

  const regex = new RegExp('([0-9]+[hms])', 'g')

  const waitTime: number = waitText
    .split(regex)
    .filter(v => !!(v.trim()))
    .map(text => {
      const parse = new RegExp('([0-9]+)([hms])', 'g').exec(text)

      if (!parse || parse.length < 3) {
        return 0
      }

      const value: number = parseInt(parse[1])
      const units: 'h' | 'm' | 's' = parse[2] as any

      return timeInMilliseconds(value, units)
    })
    .reduce((previousValue: number, currentValue: number) => {
      return currentValue + previousValue
    }, 0)

  return waitTime
}

export const hoursInMilliseconds = (hours: number): number => {
  return timeInMilliseconds(hours, 'h')
}

export const minutesInMilliseconds = (minutes: number): number => {
  return timeInMilliseconds(minutes, 'm')
}

export const secondsInMilliseconds = (seconds: number): number => {
  return timeInMilliseconds(seconds, 's')
}

const timeInMilliseconds = (value: number, units: 'h' | 'm' | 's'): number => {
  let result = value
  switch (units) {
    case 'h':
      result = result * 60
    // fallthrough to minutes calculation
    case 'm':
      result = result * 60
    // fallthrough to seconds calculation
    case 's':
      result = result * 1000
  }

  return result
}
