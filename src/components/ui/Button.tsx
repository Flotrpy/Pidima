import clsx from "clsx";
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

function classes(variant: Variant, small?: boolean, extra?: string) {
  return clsx(
    "btn",
    variant === "primary" && "btn-primary",
    variant === "danger" && "btn-danger",
    variant === "ghost" && "btn-ghost",
    small && "btn-sm",
    extra,
  );
}

export function Button({
  variant = "secondary",
  small,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return <button type={type} className={classes(variant, small, className)} {...props} />;
}

export function ButtonLink({
  href,
  variant = "secondary",
  small,
  className,
  children,
}: {
  href: string;
  variant?: Variant;
  small?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={classes(variant, small, className)}>
      {children}
    </Link>
  );
}
