import { INetflixModuleContext } from "../interfaces/netflix-module.interface.js";
import type { Task } from "../../../types/task.type.js";
import { getDataRoot } from "../../../utils/path.js";
import fs from "fs";
import path from "path";

export class NetflixGetTokenService {
  constructor(private readonly ctx: INetflixModuleContext) {}

  async execute(task: Task): Promise<any> {
    const payload = task.payload as { email: string };
    const { email } = payload;

    this.ctx.logger.info(`[GetToken] Starting Netflix token retrieval for email: ${email}`);

    const emailFileName = email.toLowerCase().replace(/[.@]/g, '_');
    
    // Use getDataRoot() to respect cloud_data_dir GDrive sync config
    const sessionPath = path.join(getDataRoot(), "session_data", `netflix_${emailFileName}.json`);

    if (!fs.existsSync(sessionPath)) {
      throw new Error(`Session cookies not found for this account on bot.`);
    }

    const sessionData = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    const netflixIdCookie = sessionData.cookies?.find((c: any) => c.name === "NetflixId");
    const secureNetflixIdCookie = sessionData.cookies?.find((c: any) => c.name === "SecureNetflixId");
    const nfvdidCookie = sessionData.cookies?.find((c: any) => c.name === "nfvdid");

    if (!netflixIdCookie) {
      throw new Error("NetflixId cookie not found in session.");
    }

    const cookieStrings: string[] = [];
    if (netflixIdCookie) cookieStrings.push(`NetflixId=${netflixIdCookie.value}`);
    if (secureNetflixIdCookie) cookieStrings.push(`SecureNetflixId=${secureNetflixIdCookie.value}`);
    if (nfvdidCookie) cookieStrings.push(`nfvdid=${nfvdidCookie.value}`);
    
    const cookieHeader = cookieStrings.join('; ');

    const QUERY_PARAMS: Record<string, string> = {
      "appVersion": "15.48.1",
      "config": '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
      "device_type": "NFAPPL-02-",
      "esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
      "idiom": "phone",
      "iosVersion": "15.8.5",
      "isTablet": "false",
      "languages": "en-US",
      "locale": "en-US",
      "maxDeviceWidth": "375",
      "model": "saget",
      "modelType": "IPHONE8-1",
      "odpAware": "true",
      "path": '["account","token","default"]',
      "pathFormat": "graph",
      "pixelDensity": "2.0",
      "progressive": "false",
      "responseFormat": "json"
    };

    const urlObj = new URL("https://ios.prod.ftl.netflix.com/iosui/user/15.48");
    for (const [k, v] of Object.entries(QUERY_PARAMS)) {
      urlObj.searchParams.set(k, v);
    }

    const headers = {
      "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
      "x-netflix.request.attempt": "1",
      "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
      "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
      "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
      "x-netflix.context.app-version": "15.48.1",
      "x-netflix.argo.translated": "true",
      "x-netflix.context.form-factor": "phone",
      "x-netflix.context.sdk-version": "2012.4",
      "x-netflix.client.appversion": "15.48.1",
      "x-netflix.context.max-device-width": "375",
      "x-netflix.context.ab-tests": "",
      "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
      "x-netflix.client.type": "argo",
      "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
      "x-netflix.context.locales": "en-US",
      "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
      "x-netflix.client.iosversion": "15.8.5",
      "accept-language": "en-US;q=1",
      "x-netflix.argo.abtests": "",
      "x-netflix.context.os-version": "15.8.5",
      "x-netflix.request.client.context": '{"appState":"foreground"}',
      "x-netflix.context.ui-flavor": "argo",
      "x-netflix.argo.nfnsm": "9",
      "x-netflix.context.pixel-density": "2.0",
      "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
      "x-netflix.request.client.timezoneid": "Asia/Dhaka",
      "Cookie": cookieHeader
    };

    const fetchResponse = await fetch(urlObj.toString(), {
      method: "GET",
      headers: headers
    });

    if (!fetchResponse.ok) {
      const errText = await fetchResponse.text();
      throw new Error(`Netflix FTL API Error: ${fetchResponse.status} - ${errText}`);
    }

    const resJson = (await fetchResponse.json()) as any;
    const nftoken = resJson?.value?.account?.token?.default?.token;

    if (!nftoken) {
      throw new Error("nftoken not found in FTL response.");
    }

    this.ctx.logger.info(`[GetToken] Successfully fetched Netflix token for ${email}`);
    return { token: nftoken };
  }
}
