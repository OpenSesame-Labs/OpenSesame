/**
 * Plan a trunk CD npm publish at 0.0.0-<preid>.N with dist-tag <preid>.
 */
import {
  CD_PREVIEW_DIST_TAG,
  listNpmVersions,
  nextCdPrereleaseVersion,
  normalizeReleaseSha,
  npmDistTagForPrerelease,
} from "./npm-prerelease-version.mjs";

/**
 * @param {{
 *   npmPackageName: string,
 *   sha: string,
 *   tagPrefix: string,
 *   releaseName: string,
 *   preid?: string,
 *   npmVersions?: readonly string[],
 * }} input
 */
export function planNpmCdRelease(input) {
  const preid = input.preid ?? CD_PREVIEW_DIST_TAG;
  const npmVersions =
    input.npmVersions ?? listNpmVersions(input.npmPackageName);
  const version = nextCdPrereleaseVersion(npmVersions, preid);
  const shortSha = normalizeReleaseSha(input.sha);
  const npmDistTag = npmDistTagForPrerelease(version, preid);
  return {
    version,
    tag: `${input.tagPrefix}${version}`,
    releaseTitle: `${input.releaseName} ${version} (+${shortSha})`,
    shortSha,
    npmDistTag,
    alsoGithubPackages: true,
  };
}
