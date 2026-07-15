const BUFFERED_STDOUT_THRESHOLD_BYTES = 64 * 1024;

export async function writeCliOutput(output: string): Promise<void> {
  const terminated = `${output}\n`;
  if (Buffer.byteLength(terminated, "utf8") < BUFFERED_STDOUT_THRESHOLD_BYTES) {
    console.log(output);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    process.stdout.write(terminated, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
