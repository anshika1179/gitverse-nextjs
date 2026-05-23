import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/middleware";

/**
 * Handles logout requests by validating the authorization header
 * and ensuring the user token is valid.
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");

    if (!authHeader) {
      return NextResponse.json(
        { error: "Authorization header is required" },
        { status: 400 }
      );
    }

    if (!authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        {
          error:
            "Malformed Authorization header, expected 'Bearer <token>'",
        },
        { status: 400 }
      );
    }

    const token = authHeader.split(" ")[1];

    if (!token || token.trim() === "") {
      return NextResponse.json(
        {
          error:
            "Malformed Authorization header, expected 'Bearer <token>'",
        },
        { status: 400 }
      );
    }

    const user = await getAuthUser(request);

    if (!user) {
      return NextResponse.json(
        { error: "Invalid or expired authentication token" },
        { status: 401 }
      );
    }

    return NextResponse.json({
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Logout error:", error);

    return NextResponse.json(
      { error: "Failed to process logout request" },
      { status: 500 }
    );
  }
}