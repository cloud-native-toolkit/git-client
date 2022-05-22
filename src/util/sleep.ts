
const sleep = async (interval: number): Promise<void> => {
  return new Promise(resolve => {
    setTimeout(() => resolve(), interval)
  })
}

export default sleep
