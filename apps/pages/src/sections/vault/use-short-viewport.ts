import { useEffect, useState } from "react";

function isShortViewport(): boolean {
  return (window.visualViewport?.height ?? window.innerHeight) < 480;
}

/** Leave room for editor fields when the on-screen keyboard reduces the view. */
export function useShortViewport(): boolean {
  const [short, setShort] = useState(isShortViewport);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => setShort(isShortViewport());
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    update();
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return short;
}
