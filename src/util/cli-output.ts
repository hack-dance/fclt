export async function writeCliOutput(output: string): Promise<void> {
  const terminated = `${output}\n`;
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
