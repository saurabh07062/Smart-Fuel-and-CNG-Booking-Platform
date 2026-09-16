import { NavLink } from "react-router-dom";

/**
 * Mobile bottom bar -- the same destinations as the desktop sidebar, with
 * "Book" raised in the middle because it is the app's primary action.
 */
const ITEMS = [
  { to: "/dashboard", icon: "fa-house", label: "Home", end: true },
  { to: "/stations", icon: "fa-map-location-dot", label: "Stations", end: false },
  { to: "/booking", icon: "fa-plus", label: "Book", end: false, primary: true },
  { to: "/confirmation", icon: "fa-qrcode", label: "QR Pass", end: false },
  { to: "/my-vehicles", icon: "fa-car-side", label: "Vehicles", end: false },
];

export default function BottomNav() {
  return (
    <nav className="cx-bottomnav" aria-label="Primary">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => `${isActive ? "active" : ""} ${item.primary ? "is-primary" : ""}`}
        >
          <i className={`fas ${item.icon}`} aria-hidden />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
