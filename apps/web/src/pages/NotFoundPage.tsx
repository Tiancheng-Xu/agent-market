import { Link } from "react-router-dom";
import { Panel } from "../components/Ui";
import { Localized } from "../i18n/LanguageProvider";

export function NotFoundPage() { return <Localized><Panel className="empty-state not-found"><span className="empty-mark">404</span><h1>Route not found</h1><p>The requested Agent Market surface does not exist.</p><Link className="button button-primary" to="/">Return to market</Link></Panel></Localized>; }
