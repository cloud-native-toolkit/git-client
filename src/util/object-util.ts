
export const isUndefinedOrNull = (val: any) => {
  return val === undefined || val === null
}

export const isDefinedAndNotNull = (val: any) => {
  return val !== undefined && val !== null
}
