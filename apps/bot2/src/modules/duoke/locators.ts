/**
 * Locators for Duoke Chat
 */

import { Page, Locator } from 'playwright';

// Login Page
export const getEmailInput = (page: Page) => page.locator('input[placeholder="Email"]');
export const getPasswordInput = (page: Page) => page.locator('input[placeholder="Password"]');
export const getCaptchaInput = (page: Page) => page.locator('input[placeholder="Verification Code"]');
export const getPolicyCheckbox = (page: Page) => page.locator('.policy_checkbox input[type="checkbox"]');
export const getLoginButton = (page: Page) => page.locator('button:has-text("Login")');

// Chat Page
export const getClosePopupButton = (page: Page) => page.locator('i.dk-dialog__close, i.el-dialog__close.el-icon.el-icon-close, [class*="dialog__close"]');
export const getUnansweredTab = (page: Page) => page.locator('i.icon_unanswered');
export const getUnreadBadge = (page: Page) => page.locator('sup.dk-badge__content:visible, sup.el-badge__content:visible, sup[class*="-badge__content"]:visible');
export const getBuyerName = (container: Locator) => container.locator('div.buyer_name, [class*="buyer_name"], [class*="buyerName"]');
export const getChatTextarea = (page: Page) => page.locator('textarea').last();
export const getSendButton = (page: Page) => page.locator('i.icon_send_chatbox');
export const getOrderTab = (page: Page) => page.locator('#tab-order');
export const getReadyToShipTag = (page: Page) => page.locator('#pane-order [class*="tag"]:has-text("Ready to Ship")');
export const getUnpaidTag = (page: Page) => page.locator('#pane-order [class*="tag"]:has-text("Unpaid")');
export const getShippedTag = (page: Page) => page.locator('#pane-order [class*="tag"]:has-text("Shipped")');
export const getPaymentAmount = (page: Page) => page.locator('.order_item_buyer .fw_700').first();
export const getPaymentTime = (page: Page) => page.locator('.order_item_time').first();

// Helper to find valid chat items (has VISIBLE specific badge AND buyer name)
export const getChatItem = (page: Page) => 
    page.locator('div, li').filter({ 
        has: page.locator('sup.dk-badge__content.is-fixed:visible, sup.el-badge__content.is-fixed:visible, sup[class*="-badge__content"].is-fixed:visible') 
    }).filter({ 
        has: page.locator('div.buyer_name, [class*="buyer_name"], [class*="buyerName"]') 
    });

// Helper to find chat item container from badge
export const getChatItemContainer = (badge: Locator) => badge.locator('xpath=./ancestor::div[contains(@class, "chat_item")]');

// Order detail locators
export const getOrderId = (page: Page) => 
    page.locator('#pane-order [class*="order_sn"], #pane-order [class*="order_id"], #pane-order .order_number, #pane-order [class*="sn"]').first();

export interface ChatMessage {
    sender: 'buyer' | 'seller';
    text: string;
}

/**
 * Extracts recent chat messages from the active chat window in Duoke
 */
export async function extractRecentChatMessages(page: Page, limit = 8): Promise<ChatMessage[]> {
    try {
        return await page.evaluate((maxCount) => {
            const doc = (globalThis as any).document;
            if (!doc) return [];

            const timeRegex = /^\d{2}\/\d{2}\s+\d{2}:\d{2}$/;
            const allElements = Array.from(doc.querySelectorAll('*')) as any[];

            // Cari elemen timestamp seperti "10/19 14:25"
            const timeNodes = allElements.filter(el => {
                const txt = el.innerText?.trim();
                return txt && timeRegex.test(txt) && el.children.length === 0;
            });

            if (timeNodes.length > 0) {
                const extracted: Array<{ sender: 'buyer' | 'seller'; text: string }> = [];

                for (const timeEl of timeNodes.slice(-maxCount)) {
                    const parent = timeEl.parentElement;
                    const grandParent = parent?.parentElement;
                    const greatGrandParent = grandParent?.parentElement;

                    // Cari elemen gelembung teks yang berdekatan dengan timestamp
                    let bubbleEl: any = null;

                    // Cek sibling dari timeEl
                    if (parent) {
                        for (const child of Array.from(parent.children) as any[]) {
                            if (child !== timeEl && child.innerText?.trim() && !timeRegex.test(child.innerText.trim())) {
                                bubbleEl = child;
                                break;
                            }
                        }
                    }

                    // Cek sibling dari parent jika di parent belum ketemu
                    if (!bubbleEl && grandParent) {
                        for (const child of Array.from(grandParent.children) as any[]) {
                            if (child !== parent && child.innerText?.trim() && !timeRegex.test(child.innerText.trim())) {
                                bubbleEl = child;
                                break;
                            }
                        }
                    }

                    // Cek greatGrandParent jika struktur bersarang lebih dalam
                    if (!bubbleEl && greatGrandParent) {
                        for (const child of Array.from(greatGrandParent.children) as any[]) {
                            if (child !== grandParent && child.innerText?.trim() && !timeRegex.test(child.innerText.trim())) {
                                bubbleEl = child;
                                break;
                            }
                        }
                    }

                    if (bubbleEl) {
                        const rawText = bubbleEl.innerText?.trim() || '';
                        const text = rawText.replace(/\d{2}\/\d{2}\s+\d{2}:\d{2}/g, '').trim();

                        if (text && text.length > 0) {
                            const combinedClass = [
                                bubbleEl.className || '',
                                parent?.className || '',
                                grandParent?.className || '',
                                greatGrandParent?.className || '',
                            ].join(' ').toLowerCase();

                            let isSeller = /right|send|seller|mine|self|owner|is-me/i.test(combinedClass);

                            // Cek styling (kanan vs kiri atau warna gelembung)
                            try {
                                const style = (globalThis as any).getComputedStyle(bubbleEl);
                                const parentStyle = parent ? (globalThis as any).getComputedStyle(parent) : null;
                                if (
                                    style.float === 'right' ||
                                    style.textAlign === 'right' ||
                                    parentStyle?.justifyContent === 'flex-end' ||
                                    parentStyle?.flexDirection?.includes('reverse')
                                ) {
                                    isSeller = true;
                                }

                                // Gelembung toko Duoke berwarna biru muda
                                const bg = style.backgroundColor || '';
                                if (bg.includes('236, 245, 255') || bg.includes('217, 236, 255') || bg.includes('64, 158, 255') || bg.includes('225, 243, 216') || bg.includes('216, 236, 255')) {
                                    isSeller = true;
                                }
                            } catch (e) {}

                            extracted.push({
                                sender: isSeller ? 'seller' : 'buyer',
                                text,
                            });
                        }
                    }
                }

                if (extracted.length > 0) {
                    return extracted;
                }
            }

            // Fallback class selector
            const selectors = [
                '.chat_record .msg_item',
                '.chat_record [class*="msg_item"]',
                '.chat_content [class*="msg_item"]',
                '.chat_content .message_item',
                '.chat_main [class*="message"]',
                '.chat_msg_item',
                '.msg_item',
                'div[class*="message_item"]',
                'div[class*="chat_item_msg"]'
            ];

            let elements: any[] = [];
            for (const sel of selectors) {
                const found = Array.from(doc.querySelectorAll(sel));
                if (found.length > 0) {
                    elements = found;
                    break;
                }
            }

            const results: Array<{ sender: 'buyer' | 'seller'; text: string }> = [];
            for (const el of elements.slice(-maxCount)) {
                const text = el.innerText?.trim() || '';
                if (!text) continue;
                const classList = ((el.className || '') + ' ' + (el.parentElement?.className || '')).toLowerCase();
                const isSeller = /right|is-me|is-send|seller|my-msg|owner/i.test(classList);
                results.push({
                    sender: isSeller ? 'seller' : 'buyer',
                    text,
                });
            }

            return results;
        }, limit);
    } catch {
        return [];
    }
}


