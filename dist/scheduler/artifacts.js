export const artifactInput = (artifacts, value) => ({
    artifacts,
    ...(value === undefined ? {} : { value }),
});
export const artifactOutput = (artifacts, value) => ({
    artifacts,
    ...(value === undefined ? {} : { value }),
});