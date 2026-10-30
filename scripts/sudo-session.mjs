// Keep authentication structurally after a successful build, including tests.
export async function sudoSession({ build, authenticate, launch }) {
  await build({ afterBuild: async (executable) => {
    await authenticate();
    await launch(executable);
  } });
}
