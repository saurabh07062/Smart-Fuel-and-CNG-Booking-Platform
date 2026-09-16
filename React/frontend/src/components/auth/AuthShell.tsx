import type { ReactNode } from "react";

/**
 * The signed-out page frame Login and Register draw: background image with its
 * dark wash, the logo block, and a centred card column. Used by the password
 * reset pages so they look like the rest of the sign-in flow.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div
      className="min-h-screen flex flex-col justify-between"
      style={{ background: "url('/bg-image.png') center/cover", position: "relative" }}
    >
      <div className="absolute inset-0" style={{ background: "rgba(11,17,32,0.7)" }} />

      <div className="relative z-10 pt-12 flex flex-col items-center">
        <div
          className="w-20 h-20 rounded-[20px] flex items-center justify-center shadow-lg"
          style={{ background: "#2563eb" }}
        >
          <i className="fas fa-gas-pump text-white text-[32px]" aria-hidden />
        </div>
        <h1
          className="text-[28px] font-bold text-white mt-3 drop-shadow-md"
          style={{ fontFamily: "'Space Grotesk'" }}
        >
          {title}
        </h1>
        <p className="text-[15px] font-medium text-gray-200 mt-1 drop-shadow">{subtitle}</p>
      </div>

      <div className="w-full max-w-md relative z-10 mx-auto mt-8 mb-auto px-4 pb-12">{children}</div>
    </div>
  );
}
