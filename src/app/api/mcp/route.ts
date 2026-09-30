import { authenticateBearer } from "@/mcp/auth";
import { handleMcpRequest } from "@/mcp/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handle = (req: Request) => handleMcpRequest(req, authenticateBearer);

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
