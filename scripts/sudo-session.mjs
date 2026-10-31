// Authenticate only after building or validating the explicitly reused build.
export async function sudoSession({ build, authenticate, launch }) {
  await build({ afterBuild: async (executable) => {
    await authenticate();
    await launch(executable);
  } });
}
