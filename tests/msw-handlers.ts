import { http, HttpResponse } from "msw";
import { EMBY_HOST } from "./constants.js";

/**
 * Default MSW handlers. They intentionally:
 *   - mirror the real Emby path structure under `/emby/...`
 *   - echo request metadata (method, headers, query, body) so tests can
 *     assert how the client shaped the outbound call.
 */
export const defaultHandlers = [
  // System ping
  http.get(`${EMBY_HOST}/emby/System/Ping`, () => HttpResponse.json({ pong: true })),
  // System info
  http.get(`${EMBY_HOST}/emby/System/Info`, ({ request }) => {
    const token = request.headers.get("x-emby-token");
    return HttpResponse.json({
      ServerName: "Test Emby",
      Version: "4.8.0.0",
      _auth: token,
    });
  }),
  http.get(`${EMBY_HOST}/emby/System/Info/Public`, () =>
    HttpResponse.json({ ServerName: "Test Emby", LocalAddress: EMBY_HOST })
  ),

  // Items
  http.get(`${EMBY_HOST}/emby/Items`, ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({
      Items: [
        { Id: "item-1", Name: "Test Movie" },
        { Id: "item-2", Name: "Another Movie" },
      ],
      TotalRecordCount: 2,
      _query: Object.fromEntries(url.searchParams.entries()),
    });
  }),
  http.get(`${EMBY_HOST}/emby/Items/:id`, ({ params }) =>
    HttpResponse.json({ Id: params.id, Name: `Item ${params.id}` })
  ),

  // Users
  http.get(`${EMBY_HOST}/emby/Users`, () =>
    HttpResponse.json([
      { Id: "user-1", Name: "alice" },
      { Id: "user-2", Name: "bob" },
    ])
  ),
  http.get(`${EMBY_HOST}/emby/Users/:id`, ({ params }) =>
    HttpResponse.json({ Id: params.id, Name: "alice" })
  ),
  http.get(`${EMBY_HOST}/emby/Users/:userId/Items/:id`, ({ params }) =>
    HttpResponse.json({
      Id: params.id,
      Name: `User ${params.userId} scoped item ${params.id}`,
    })
  ),

  // Sessions
  http.get(`${EMBY_HOST}/emby/Sessions`, () =>
    HttpResponse.json([{ Id: "s1", UserName: "alice" }])
  ),

  // Library
  http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () =>
    HttpResponse.json([{ Name: "Movies", CollectionType: "movies" }])
  ),

  // Plugins
  http.get(`${EMBY_HOST}/emby/Plugins`, () =>
    HttpResponse.json([{ Name: "Test Plugin", Version: "1.0.0" }])
  ),
];
